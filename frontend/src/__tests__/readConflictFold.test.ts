import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { readConflictCount, readConflictNotice } from '../tools/read-conflicts.js'
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

function payloads(): Record<string, unknown>[] {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/read-conflict-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const value = parseJson(raw)
  if (!Array.isArray(value)) throw new Error('missing producer envelopes')
  return value.map(item => {
    const p = record(item)
    if (!p) throw new Error('missing producer envelope')
    return p
  })
}

describe('read marker-pair report in completed work', () => {
  it('keeps the pinned report visible once in order and preserves outcome', () => {
    const p = payloads()[0]
    if (!p) throw new Error('missing read envelope')
    const transcript = new Transcript()
    transcript.toolComplete(stub(p), 5)
    const c = transcript.call(toolCallId(String(p['tool_call_id'])))
    if (!c) throw new Error('missing live read')
    const read = tool('read', c)
    const t = turn([tool('before', call('terminal')), read, tool('after', call('terminal')), text('answer')])
    expect(readConflictCount(c)).toBe(1)
    expect(foldOf(t)?.hidden.has(read.id)).toBe(false)
    expect(parts(t).map(part => `${part.kind}:${part.blocks.map(item => item.id).join(',')}`))
      .toEqual(['fold:before', 'shown:read', 'fold:after', 'shown:answer'])
    expect(pieces([read], t.blocks)).toEqual([{ kind: 'block', block: read }])
    const root = tree(entryNode(t, 'main.read-conflict', cx))
    const cards = nodes(root).filter(n => n.k === 'tool' && n.p?.['name'] === 'read')
    expect(cards).toHaveLength(1)
    const card = cards[0]
    expect(card?.p).toMatchObject({ status: 'done', collapsed: false })
    const view = JSON.stringify(root)
    expect(view).toContain(readConflictNotice(1))
    expect(view).not.toContain('unresolved git merge-conflict')
    expect(view).not.toContain('Resolve them')
  })

  it('leaves invalid, contradictory, unfinished and uninspectable reads folded', () => {
    const valid = { content: '1|returned', conflict_blocks: 1 }
    for (const result of [
      {}, { ...valid, conflict_blocks: 0 }, { ...valid, conflict_blocks: -1 },
      { ...valid, conflict_blocks: 1.5 }, { ...valid, conflict_blocks: '1' },
      { ...valid, content: '' }, { ...valid, content_returned: false }, { ...valid, status: 'unchanged' },
      { ...valid, is_binary: true }, { ...valid, error: 'bad' },
      { content: '1|returned', get conflict_blocks(): never { throw Error('bad') } },
      new Proxy({}, { getOwnPropertyDescriptor() { throw Error('bad') } })
    ]) {
      const read = tool('clean', call('read_file', { path: 'x' }, { result }))
      expect(foldOf(turn([read, text('answer')]))?.hidden.has(read.id)).toBe(true)
      expect(pieces([read])).toEqual([{ kind: 'work', items: [read] }])
    }
    const read = tool('cancelled', call('read_file', { path: 'x' }, { result: valid, outcome: { kind: 'cancelled', duration: 1 } }))
    expect(foldOf(turn([read, text('answer')]))?.hidden.has(read.id)).toBe(true)
  })

  it('keeps retained replay evidence visible but does not invent missing results', () => {
    const p = payloads()[1]
    if (!p) throw new Error('missing reverse-marker envelope')
    const args = record(p['args'])
    if (!args) throw new Error('missing args')
    let n = 0
    const replay = (content?: string) => history({ kept: [], id: prefix => entryId(`${prefix}${++n}`), messages: [
      { role: 'tool', name: 'read_file', tool_call_id: 'reverse', args, ...(content ? { content } : {}) },
      { role: 'assistant', text: 'answer' }
    ] }).find(e => e.kind === 'turn')
    const kept = replay(String(p['result']))
    const lost = replay()
    if (!kept || kept.kind !== 'turn' || !lost || lost.kind !== 'turn') throw new Error('missing replay')
    expect(JSON.stringify(tree(entryNode(kept, 'main.kept', cx)))).toContain(readConflictNotice(1))
    expect(JSON.stringify(tree(entryNode(lost, 'main.lost', cx)))).not.toContain('possible conflict marker')
  })
})
