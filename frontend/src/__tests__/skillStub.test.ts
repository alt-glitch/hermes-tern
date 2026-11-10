import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId } from '../core/ids.js'
import type { Block, Todo, TurnEntry } from '../model.js'
import { history } from '../transcript/history.js'
import { dockNodes } from '../view/dock.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { stepLabel } from '../view/workLogModel.js'
import { parseJson, record } from '../wire/json.js'

import { dockActions, dockContext } from './dockFakes.js'
import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const NOTICE = 'Hermes reports this skill view is unchanged; content was not returned.'
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const texts = (roots: NodeJson[]) => roots.flatMap(nodes).map(n => JSON.stringify(n.p ?? {})).join('\n')
const skill = (result: unknown, args: Record<string, unknown> = { name: 'example' }) => call('skill_view', args, { result })
const producer = () => {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/skill-stub-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const parsed = parseJson(raw)
  if (!Array.isArray(parsed)) throw new Error('expected results')
  return parsed.map(record)
}

describe('unchanged skill view', () => {
  it('shows pinned producer stub, file identity and grouped detail without old content', () => {
    const [main, file] = producer()
    for (const [payload, args, identity] of [
      [main, { name: 'example' }, 'SKILL.md'], [file, { name: 'example', file_path: 'references/guide.md' }, 'references/guide.md']
    ] as const) {
      expect(payload).toMatchObject({ success: true, status: 'unchanged', dedup: true, content_returned: false, file: identity })
      const c = skill(payload, args)
      expect(stepLabel(c)).toBe('Skill view unchanged: example')
      const root = tree(toolNode(c, 0))
      expect(root.p?.['status']).toBe('done')
      expect(root.p?.['meta']).toContain(NOTICE)
      expect(texts([root])).toContain(NOTICE)
      expect(texts([root])).toContain(identity)
      expect(texts(toolDetail(c, 0).map(tree))).toContain(NOTICE)
      expect(texts([root])).not.toContain('retained skill')
    }
  })

  it('renders retained history and keeps the actual grouped work as a fold', () => {
    const [result] = producer()
    let i = 0
    const entries = history({ kept: [], id: p => entryId(`${p}${++i}`), messages: [
      { role: 'user', text: 'read' },
      { role: 'tool', name: 'skill_view', tool_call_id: 's', args: { name: 'example' }, content: JSON.stringify(result) },
      { role: 'assistant', text: 'answer' }
    ] })
    const t = entries.find(e => e.kind === 'turn')
    const block = t?.blocks.find(b => b.kind === 'tool')
    if (!t || block?.kind !== 'tool') throw new Error('missing replay')
    expect(texts([tree(toolNode(block.call, 0))])).toContain(NOTICE)
    const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }
    const all = tree(entryNode(t, 'main.skill', cx))
    expect(JSON.stringify(all)).toContain('hermes.turn.fold')
    expect(texts([all])).toContain(NOTICE)
    expect(texts([all])).toContain('Skill view unchanged: example')
  })

  it('keeps an unchanged skill and nested todo projection together in the turn and dock', () => {
    const [result] = producer()
    if (!result) throw new Error('missing skill stub')
    const todos: Todo[] = [
      { id: 'root', content: 'Root', status: 'completed' },
      { id: 'child', content: 'Child', parent: 'root', status: 'in_progress' }
    ]
    const blocks: Block[] = [
      { kind: 'tool', id: entryId('skill'), call: skill(result) },
      { kind: 'tool', id: entryId('todo'), call: call('todo_list', { todos }, { todos }) },
      { kind: 'text', id: entryId('answer'), text: 'answer' }
    ]
    const t: TurnEntry = { kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0,
      end: { status: 'done', endedAt: 1000 }, blocks }
    const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }
    const root = tree(entryNode(t, 'main.combined', cx))
    const checklist = nodes(root).find(node => node.k === 'checklist')
    const dock = dockNodes(dockContext({ pills: { todos: { list: todos, open: true } } }), dockActions())
      .map(tree).flatMap(nodes).find(node => node.k === 'checklist')
    expect(texts([root])).toContain(NOTICE)
    expect(texts([root])).toContain('Skill view unchanged: example')
    expect(checklist?.p?.['phases']).toEqual(dock?.p?.['phases'])
    expect(JSON.stringify(checklist)).toContain('Child (child) — under Root (root)')
    expect(JSON.stringify(checklist)).toContain('"status":"active"')
    expect(JSON.stringify(root)).toContain('answer')
  })

  it('rejects malformed, conflicting or non-settled claims without hiding content', () => {
    const [valid] = producer()
    if (!valid) throw new Error('missing stub')
    const variants = [
      { ...valid, status: 'changed' }, { ...valid, dedup: 'true' }, { ...valid, content_returned: true },
      { ...valid, success: false }, { ...valid, error: 'failed' }, { ...valid, content: 'new body' },
      { ...valid, file: 'other.md' }, { ...valid, setup_needed: true },
      { ...valid, status: 'unchanged', failed: true }, Object.create(valid), null
    ]
    for (const result of variants) expect(texts([tree(toolNode(skill(result), 0))])).not.toContain(NOTICE)
    const full = tree(toolNode(skill({ success: true, content: 'actual skill' }), 0))
    expect(texts([full])).toContain('actual skill')
    const error = call('skill_view', { name: 'example' }, { result: valid, outcome: { duration: 1, kind: 'error' } })
    const cancelled = call('skill_view', { name: 'example' }, { result: valid, outcome: { duration: 1, kind: 'cancelled' } })
    const running = call('skill_view', { name: 'example' }, { result: valid, outcome: { kind: 'running' } })
    for (const c of [error, cancelled, running]) expect(texts([tree(toolNode(c, 0))])).not.toContain(NOTICE)
  })

  it('bounds and escapes a supplied linked-file identity', () => {
    const [valid] = producer()
    if (!valid) throw new Error('missing stub')
    const path = 'x\u001b\u202e' + 'y'.repeat(300)
    const c = skill({ ...valid, file: path, message: 'private message' }, { name: 'example', file_path: path })
    const root = tree(toolNode(c, 0))
    const rendered = texts([root])
    expect(rendered).toContain(NOTICE)
    expect(rendered).toContain('\\\\u001b')
    expect(rendered).toContain('\\\\u202e')
    expect(rendered).toContain('File name clipped in view')
    expect(rendered).not.toContain('private message')
  })
})
