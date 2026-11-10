import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { PATCH_CONTEXT_WARNING, patchContextWarning } from '../tools/patch-warning.js'
import { history } from '../transcript/history.js'
import { Transcript } from '../transcript/store.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { foldOf, parts, pieces } from '../view/workLogModel.js'
import { parseJson, record } from '../wire/json.js'
import { stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const tool = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: entryId(id), call: c })
const text = (id: string): Block => ({ kind: 'text', id: entryId(id), text: id })
const turn = (blocks: Block[]): TurnEntry => ({ kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks })
const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]

function payload(): Record<string, unknown> {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/patch-context-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const value = record(parseJson(raw))
  if (!value) throw new Error('missing producer envelope')
  return value
}

describe('patch context warning visibility in work', () => {
  it('keeps an actual retained Hermes warning visible once, in order and with its real status', () => {
    const p = payload()
    const transcript = new Transcript()
    transcript.toolComplete(stub(p), 5)
    const c = transcript.call(toolCallId('patch-warning'))
    if (!c) throw new Error('missing live patch')
    const b = tool('patch', c)
    const t = turn([tool('before', call('terminal')), b, tool('after', call('terminal')), text('answer')])
    expect(patchContextWarning(c)).toBe(true)
    expect(foldOf(t)?.hidden.has(b.id)).toBe(false)
    expect(parts(t).map(part => `${part.kind}:${part.blocks.map(item => item.id).join(',')}`))
      .toEqual(['fold:before', 'shown:patch', 'fold:after', 'shown:answer'])
    expect(pieces([b], t.blocks)).toEqual([{ kind: 'block', block: b }])
    const root = tree(entryNode(t, 'main.patch-warning', cx))
    const card = nodes(root).find(n => n.k === 'tool' && n.p?.['name'] === 'edit')
    expect(card?.p).toMatchObject({ status: 'done', collapsed: false })
    const view = JSON.stringify(root)
    expect(view.split(PATCH_CONTEXT_WARNING)).toHaveLength(2)
    expect(view).not.toContain('/backend/private')
    expect(view).not.toContain('sibling-secret')
  })

  it('keeps error warnings visible and unrelated or malformed results folded', () => {
    const args = { mode: 'replace', path: 'x.py', old_string: 'before', new_string: 'after' }
    const error = tool('error', call('patch', args, { result: { _warning: 'private', error: 'failed' }, outcome: { kind: 'error', duration: 1 } }))
    expect(pieces([error])).toEqual([{ kind: 'block', block: error }])
    expect(JSON.stringify(tree(entryNode(turn([error, text('answer')]), 'main.error', cx)))).toContain(PATCH_CONTEXT_WARNING)
    for (const result of [{}, { _warning: '' }, { _warning: '  ' }, { _warning: null }, { _warning: 5 }, Object.create({ _warning: 'inherited' })]) {
      const clean = tool('clean', call('patch', args, { result }))
      expect(foldOf(turn([clean, text('answer')]))?.hidden.has(clean.id)).toBe(true)
      expect(pieces([clean])).toEqual([{ kind: 'work', items: [clean] }])
    }
    const unrelated = tool('write', call('write_file', { path: 'x.py', content: 'text' }, { result: { _warning: 'private' } }))
    // A retained write warning now has its own independent visibility predicate.
    expect(foldOf(turn([unrelated, text('answer')]))?.hidden.has(unrelated.id)).not.toBe(true)
    expect(pieces([unrelated])).toEqual([{ kind: 'block', block: unrelated }])
  })

  it('fails closed when retained warning or unrelated lint properties throw', () => {
    const args = { mode: 'replace', path: 'x.py', old_string: 'before', new_string: 'after' }
    for (const key of ['_warning', 'lint']) {
      const result: Record<string, unknown> = { success: true }
      Object.defineProperty(result, key, { enumerable: true, get: () => { throw new Error('bad retained property') } })
      const malformed = tool('malformed', call('patch', args, { result, resultText: 'safe retained result' }))
      expect(patchContextWarning(malformed.call)).toBe(false)
      expect(foldOf(turn([malformed, text('answer')]))?.hidden.has(malformed.id)).toBe(true)
      expect(pieces([malformed])).toEqual([{ kind: 'work', items: [malformed] }])
    }
    const hostile = new Proxy({ success: true }, { getOwnPropertyDescriptor: () => { throw new Error('bad descriptor') } })
    const malformed = call('patch', args, { result: hostile, resultText: 'safe retained result' })
    expect(patchContextWarning(malformed)).toBe(false)
  })

  it('preserves neighboring attention and only discloses retained replay results', () => {
    const web = tool('web', call('web_extract', {}, { result: { results: [{ error: 'failed' }] } }))
    const task = tool('task', call('delegate_task', {}, { result: { results: [{ status: 'completed', exit_reason: 'max_iterations', truncated: true, summary: 'partial' }] } }))
    const evaluation = tool('eval', call('execute_code', {}, { result: { stdout_truncated: true, output: 'partial' } }))
    const warned = tool('patch', call('patch', { mode: 'replace', path: 'x.py', old_string: 'a', new_string: 'b' }, { result: { _warning: 'private' } }))
    const t = turn([web, task, evaluation, warned, text('answer')])
    expect(parts(t).flatMap(part => part.blocks.map(item => item.id))).toEqual(['web', 'task', 'eval', 'patch', 'answer'])
    const view = JSON.stringify(tree(entryNode(t, 'main.combined', cx)))
    expect(view).toContain('At least one delegated task reached its iteration limit')
    expect(view).toContain('Hermes reports stdout was truncated')
    expect(view).toContain(PATCH_CONTEXT_WARNING)

    const p = payload()
    const args = record(p['args'])
    if (!args) throw new Error('missing args')
    let n = 0
    const replay = (content?: string) => history({ kept: [], id: prefix => entryId(`${prefix}${++n}`), messages: [
      { role: 'tool', name: 'patch', tool_call_id: 'patch-warning', args, ...(content ? { content } : {}) },
      { role: 'assistant', text: 'answer' }
    ] }).find(e => e.kind === 'turn')
    const kept = replay(String(p['result']))
    const lost = replay()
    if (!kept || kept.kind !== 'turn' || !lost || lost.kind !== 'turn') throw new Error('missing replay')
    expect(JSON.stringify(tree(entryNode(kept, 'main.kept', cx)))).toContain(PATCH_CONTEXT_WARNING)
    expect(JSON.stringify(tree(entryNode(lost, 'main.lost', cx)))).not.toContain(PATCH_CONTEXT_WARNING)
  })
})
