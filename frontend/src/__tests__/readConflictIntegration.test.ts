import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { readConflictNotice } from '../tools/read-conflicts.js'
import { Transcript } from '../transcript/store.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { foldOf, parts, pieces } from '../view/workLogModel.js'
import { parseJson, record } from '../wire/json.js'
import { stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const tool = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: entryId(id), call: c })
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }

function envelopes(name: string): Record<string, unknown>[] {
  const raw = execFileSync('python3', [resolve(`src/__tests__/fixtures/${name}`)], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const value = parseJson(raw)
  if (!Array.isArray(value)) throw new Error('missing producer envelopes')
  return value.map(item => {
    const p = record(item)
    if (!p) throw new Error('invalid producer envelope')
    return p
  })
}

it('retains read marker heuristics and background notification limits alongside earlier attention', () => {
  const reads = envelopes('read-conflict-core.py')
  const terminal = envelopes('terminal-async-notify-core.py')[0]
  if (!reads[0] || !reads[1] || !terminal) throw new Error('missing producer event')
  const transcript = new Transcript()
  for (const [id, event] of [['valid', reads[0]], ['reverse', reads[1]], ['notify', terminal]] as const) {
    transcript.toolComplete(stub({ ...event, tool_id: id, tool_call_id: id }), 5)
  }
  const valid = transcript.call(toolCallId('valid'))
  const reverse = transcript.call(toolCallId('reverse'))
  const notify = transcript.call(toolCallId('notify'))
  if (!valid || !reverse || !notify) throw new Error('missing completed calls')
  const before = tool('before', call('terminal'))
  const read = tool('read', valid)
  const reversed = tool('reverse', reverse)
  const background = tool('background', notify)
  const malformed = tool('malformed', call('read_file', { path: 'x' }, { result: { content: '1|text', conflict_blocks: '1' } }))
  const memory = tool('memory', call('memory', { action: 'add' }, { result: { success: true, staged: true, pending_id: '1a2b3c4d', message: 'Pending approval' } }))
  const answer: Block = { kind: 'text', id: entryId('answer'), text: 'answer' }
  const t: TurnEntry = { kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks: [before, read, malformed, reversed, background, memory, answer] }
  expect(parts(t).flatMap(part => part.blocks.map(b => b.id))).toEqual(['before', 'read', 'malformed', 'reverse', 'background', 'memory', 'answer'])
  for (const b of [read, reversed, background, memory]) expect(foldOf(t)?.hidden.has(b.id)).toBe(false)
  expect(foldOf(t)?.hidden.has(malformed.id)).toBe(true)
  for (const b of [read, reversed]) expect(pieces([b])).toEqual([{ kind: 'block', block: b }])
  const root = tree(entryNode(t, 'main.read-conflict-integration', cx))
  const cards = nodes(root).filter(n => n.k === 'tool')
  for (const c of [valid, reverse]) {
    const card = cards.find(n => n.p?.['key'] === c.id)
    expect(card?.p).toMatchObject({ status: 'done', collapsed: false })
    const view = JSON.stringify(card)
    expect(view).toContain(readConflictNotice(1))
    expect(view).not.toContain('unresolved git merge-conflict')
    expect(view).not.toContain('Resolve them')
  }
  const backgroundCard = cards.find(n => n.p?.['key'] === notify.id)
  expect(backgroundCard?.p).toMatchObject({ status: 'done', collapsed: false })
  expect(JSON.stringify(backgroundCard)).toContain('Hermes reported that async process notifications were unavailable for this session.')
  expect(JSON.stringify(root)).toContain('memory change was staged for approval')
}, 20_000)
