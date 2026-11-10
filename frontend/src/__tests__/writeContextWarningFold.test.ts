import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { PATCH_CONTEXT_WARNING, WRITE_CONTEXT_WARNING, writeContextWarning } from '../tools/patch-warning.js'
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

function payload(mode: string): Record<string, unknown> {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/write-context-core.py'), mode], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const value = record(parseJson(raw))
  if (!value) throw new Error('missing producer envelope')
  return value
}

describe('write context warning visibility in work', () => {
  for (const mode of ['success', 'error']) {
    it(`keeps the actual retained ${mode} warning visible once in order with its real status`, () => {
      const p = payload(mode)
      const transcript = new Transcript()
      transcript.toolComplete(stub(p), 5)
      const c = transcript.call(toolCallId('write-warning'))
      if (!c) throw new Error('missing live write')
      const b = tool('write', c)
      const t = turn([tool('before', call('terminal')), b, tool('after', call('terminal')), text('answer')])
      expect(writeContextWarning(c)).toBe(true)
      expect(foldOf(t)?.hidden.has(b.id)).toBe(false)
      expect(parts(t).map(part => `${part.kind}:${part.blocks.map(item => item.id).join(',')}`))
        .toEqual(['fold:before', 'shown:write', 'fold:after', 'shown:answer'])
      expect(pieces([b], t.blocks)).toEqual([{ kind: 'block', block: b }])
      const root = tree(entryNode(t, 'main.write-warning', cx))
      const card = nodes(root).find(n => n.k === 'tool' && n.p?.['name'] === 'write')
      expect(card?.p).toMatchObject({ status: mode === 'error' ? 'error' : 'done', collapsed: false })
      const view = JSON.stringify(root)
      expect(view.split(WRITE_CONTEXT_WARNING)).toHaveLength(2)
      expect(view).not.toContain('/backend/private')
      expect(view).not.toContain('/synthetic/workspace')
    })
  }

  it('leaves unrelated, malformed, and uninspectable successful writes folded', () => {
    const args = { path: 'x.py', content: 'candidate' }
    for (const result of [{}, { _warning: '' }, { _warning: '  ' }, { _warning: null }, { _warning: 5 }, Object.create({ _warning: 'inherited' }), { get _warning(): never { throw Error('no') } }]) {
      const clean = tool('clean', call('write_file', args, { result }))
      expect(foldOf(turn([clean, text('answer')]))?.hidden.has(clean.id)).toBe(true)
      expect(pieces([clean])).toEqual([{ kind: 'work', items: [clean] }])
    }
  })

  it('preserves neighboring patch and write lint attention in reading order', () => {
    const patch = tool('patch', call('patch', { mode: 'replace', path: 'x.py', old_string: 'a', new_string: 'b' }, { result: { _warning: 'private' } }))
    const lint = tool('lint', call('write_file', { path: 'y.py', content: 'bad' }, { result: { lint: { status: 'error', output: 'syntax error' } } }))
    const warned = tool('write', call('write_file', { path: 'z.py', content: 'candidate' }, { result: { _warning: 'private' } }))
    const t = turn([patch, lint, warned, text('answer')])
    expect(parts(t).flatMap(part => part.blocks.map(item => item.id))).toEqual(['patch', 'lint', 'write', 'answer'])
    const view = JSON.stringify(tree(entryNode(t, 'main.combined', cx)))
    expect(view).toContain(PATCH_CONTEXT_WARNING)
    expect(view).toContain('Lint reported an error')
    expect(view).toContain(WRITE_CONTEXT_WARNING)
    expect(view).not.toContain('private')
  })

  it('shows retained replay warnings only when the producer result survives', () => {
    const p = payload('success')
    const args = record(p['args'])
    if (!args) throw new Error('missing args')
    let n = 0
    const replay = (content?: string) => history({ kept: [], id: prefix => entryId(`${prefix}${++n}`), messages: [
      { role: 'tool', name: 'write_file', tool_call_id: 'write-warning', args, ...(content ? { content } : {}) },
      { role: 'assistant', text: 'answer' }
    ] }).find(e => e.kind === 'turn')
    const kept = replay(String(p['result']))
    const lost = replay()
    if (!kept || kept.kind !== 'turn' || !lost || lost.kind !== 'turn') throw new Error('missing replay')
    expect(JSON.stringify(tree(entryNode(kept, 'main.kept', cx)))).toContain(WRITE_CONTEXT_WARNING)
    expect(JSON.stringify(tree(entryNode(lost, 'main.lost', cx)))).not.toContain(WRITE_CONTEXT_WARNING)
  })
})
