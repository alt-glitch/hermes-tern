import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { Transcript } from '../transcript/store.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { actionOf, foldOf, parts, pieces, stepLabel } from '../view/workLogModel.js'
import { parseJson, record } from '../wire/json.js'
import { stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const tool = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: entryId(id), call: c })
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }

function fixture(name: string): unknown {
  return parseJson(execFileSync('python3', [resolve(`src/__tests__/fixtures/${name}`)], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  }))
}

// The four isolated producer processes may exceed the default under CI load; the job bounds hangs.
it('keeps actual validation and write refusals distinct from partial V4A failures and existing attention', () => {
  const validation = record(fixture('v4a-validation-core.py'))
  const refusal = record(fixture('write-refusal-core.py'))
  const stalePayload = record(fixture('stale-write-core.py'))
  const v4a = fixture('v4a-lint-core.py')
  const payload = record(validation?.['payload'])
  if (!payload || !refusal || !stalePayload || !Array.isArray(v4a)) throw new Error('missing producer output')
  expect(validation?.['writes']).toBe(0)
  const transcript = new Transcript()
  transcript.toolComplete(stub(payload), 5)
  transcript.toolComplete(stub(refusal), 6)
  transcript.toolComplete(stub(stalePayload), 7)
  const validated = transcript.call(toolCallId('refusal'))
  const refused = transcript.call(toolCallId('write'))
  const stale = transcript.call(toolCallId('stale'))
  if (!validated || !refused || !stale) throw new Error('missing live calls')
  const noop = tool('noop', call('patch', { path: 'old.py' }, { result: { success: true, no_change: true } }))
  const validationBlock = tool('validation', validated)
  const write = tool('write', refused)
  const staleBlock = tool('stale', stale)
  const partial = tool('partial', call('patch', { mode: 'patch', patch: '*** Begin Patch\n*** End Patch' }, { result: v4a[1], outcome: { kind: 'error', duration: 1 } }))
  const memory = tool('memory', call('memory', { action: 'add' }, { result: { success: true, staged: true, pending_id: '1a2b3c4d', message: 'Pending approval' } }))
  const web = tool('web', call('web_extract', {}, { result: { results: [{ error: 'invalid URL' }] } }))
  const evaluation = tool('eval', call('execute_code', {}, { result: { stdout_truncated: true, output: 'partial' } }))
  const answer: Block = { kind: 'text', id: entryId('answer'), text: 'answer' }
  const t: TurnEntry = { kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks: [noop, validationBlock, write, staleBlock, partial, memory, web, evaluation, answer] }
  expect(parts(t).flatMap(p => p.blocks.map(b => b.id))).toEqual(['noop', 'validation', 'write', 'stale', 'partial', 'memory', 'web', 'eval', 'answer'])
  expect([validationBlock, write, staleBlock, partial, memory, web, evaluation].map(b => foldOf(t)?.hidden.has(b.id))).toEqual([false, false, false, false, false, false, false])
  for (const b of [validationBlock, write, staleBlock, partial, memory]) expect(pieces([b])).toEqual([{ kind: 'block', block: b }])
  expect(actionOf(validated)).toBe('other')
  expect(stepLabel(validated)).toBe('Patch validation failed')
  expect(actionOf(stale)).toBe('other')
  expect(stepLabel(stale)).toBe('Write refused: x.py')
  expect(actionOf(noop.call)).toBe('other')
  expect(stepLabel(noop.call)).toBe('Patch target appears present in old.py')
  const root = tree(entryNode(t, 'main.validation-integration', cx))
  const cards = nodes(root).filter(n => n.k === 'tool')
  const validationCard = cards.find(n => n.p?.['key'] === validated.id)
  const writeCard = cards.find(n => n.p?.['key'] === refused.id)
  const staleCard = cards.find(n => n.p?.['key'] === stale.id)
  const partialCard = cards.find(n => n.p?.['key'] === partial.call.id)
  for (const card of [validationCard, writeCard, staleCard, partialCard]) expect(card?.p).toMatchObject({ status: 'error', collapsed: false })
  expect(JSON.stringify(validationCard).split('no files were modified')).toHaveLength(2)
  expect(JSON.stringify(validationCard)).not.toContain('Lint reported an error')
  expect(JSON.stringify(writeCard)).toContain('Candidate content; write refused')
  expect(JSON.stringify(staleCard)).toContain('This write did not modify the file')
  expect(JSON.stringify(staleCard)).toContain('Candidate content; write refused')
  expect(JSON.stringify(staleCard)).not.toContain('/private/backend')
  expect(JSON.stringify(partialCard)).toContain('Lint reported an error for x.py')
  const rendered = JSON.stringify(root)
  for (const text of ['Target text appears present; no write performed', 'memory change was staged for approval', 'Extraction failed: invalid URL', 'Hermes reports stdout was truncated']) expect(rendered).toContain(text)
}, 20_000)
