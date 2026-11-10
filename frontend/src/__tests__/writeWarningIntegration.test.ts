import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { PATCH_CONTEXT_WARNING, WRITE_CONTEXT_WARNING } from '../tools/patch-warning.js'
import { Transcript } from '../transcript/store.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { actionOf, foldOf, parts, pieces } from '../view/workLogModel.js'
import { parseJson, record } from '../wire/json.js'
import { stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const tool = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: entryId(id), call: c })
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }

function fixture(name: string, ...args: string[]): unknown {
  return parseJson(execFileSync('python3', [resolve(`src/__tests__/fixtures/${name}`), ...args], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  }))
}

it('keeps producer-backed write and patch warnings private and visible beside prior attention', () => {
  const successPayload = record(fixture('write-context-core.py', 'success'))
  const errorPayload = record(fixture('write-context-core.py', 'error'))
  const patchPayload = record(fixture('patch-context-core.py'))
  const patches = record(fixture('patch-warning-combined-core.py'))
  const validationPayload = record(patches?.['validation'])
  const noopPayload = record(patches?.['noop'])
  if (!successPayload || !errorPayload || !patchPayload || !validationPayload || !noopPayload) throw new Error('missing producer envelope')
  expect(patches?.['writes']).toBe(0)
  const transcript = new Transcript()
  const successId = 'warning-write-success'
  const errorId = 'warning-write-error'
  transcript.toolComplete(stub({ ...successPayload, tool_id: successId, tool_call_id: successId }), 5)
  transcript.toolComplete(stub({ ...errorPayload, tool_id: errorId, tool_call_id: errorId }), 6)
  transcript.toolComplete(stub(patchPayload), 7)
  transcript.toolComplete(stub(noopPayload), 8)
  transcript.toolComplete(stub(validationPayload), 9)
  const success = transcript.call(toolCallId(successId))
  const error = transcript.call(toolCallId(errorId))
  const patch = transcript.call(toolCallId('patch-warning'))
  const noop = transcript.call(toolCallId('warning-noop'))
  const validation = transcript.call(toolCallId('warning-validation'))
  if (!success || !error || !patch || !noop || !validation) throw new Error('missing completed calls')
  const before = tool('before', call('terminal'))
  const successBlock = tool('write-success', success)
  const errorBlock = tool('write-error', error)
  const patchBlock = tool('patch', patch)
  const noopBlock = tool('noop', noop)
  const validationBlock = tool('validation', validation)
  const partial = tool('partial', call('patch', { mode: 'patch', patch: '*** Begin Patch\n*** End Patch' }, { result: {
    success: false, _warning: 'private warning', error: 'Apply phase failed (state may be inconsistent — run `git diff` to assess):\nUnable to write /backend/private/x.py'
  }, outcome: { kind: 'error', duration: 1 } }))
  const memory = tool('memory', call('memory', { action: 'add' }, { result: { success: true, staged: true, pending_id: '1a2b3c4d', message: 'Pending approval' } }))
  const answer: Block = { kind: 'text', id: entryId('answer'), text: 'answer' }
  const t: TurnEntry = { kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks: [before, successBlock, errorBlock, patchBlock, noopBlock, validationBlock, partial, memory, answer] }
  expect(parts(t).flatMap(p => p.blocks.map(b => b.id))).toEqual(['before', 'write-success', 'write-error', 'patch', 'noop', 'validation', 'partial', 'memory', 'answer'])
  for (const b of [successBlock, errorBlock, patchBlock, noopBlock, validationBlock, partial, memory]) expect(foldOf(t)?.hidden.has(b.id)).toBe(false)
  for (const b of [successBlock, errorBlock, patchBlock, noopBlock, validationBlock, partial]) expect(pieces([b])).toEqual([{ kind: 'block', block: b }])
  expect(actionOf(noop)).toBe('other')
  expect(actionOf(validation)).toBe('other')
  const root = tree(entryNode(t, 'main.write-warning-integration', cx))
  const cards = nodes(root).filter(n => n.k === 'tool')
  for (const [c, status, warning] of [[success, 'done', WRITE_CONTEXT_WARNING], [error, 'error', WRITE_CONTEXT_WARNING], [patch, 'done', PATCH_CONTEXT_WARNING], [noop, 'done', PATCH_CONTEXT_WARNING], [validation, 'error', PATCH_CONTEXT_WARNING], [partial.call, 'error', PATCH_CONTEXT_WARNING]] as const) {
    const card = cards.find(n => n.p?.['key'] === c.id)
    expect(card?.p).toMatchObject({ status, collapsed: false })
    const view = JSON.stringify(card)
    expect(view.split(warning)).toHaveLength(2)
    for (const secret of ['/backend/private', '/synthetic/workspace', 'sibling-secret', 'Synthetic write failure', 'private warning', 'Unable to write']) expect(view).not.toContain(secret)
  }
  const view = JSON.stringify(root)
  expect(view).toContain('Candidate content; Hermes reported a write error')
  expect(view).toContain('Target text appears present; no write performed')
  expect(view).toContain('Patch validation failed (no files were modified)')
  expect(view).toContain('Apply phase failed (state may be inconsistent')
  expect(view).toContain('memory change was staged for approval')
}, 20_000)
