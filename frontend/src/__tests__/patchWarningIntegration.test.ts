import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { PATCH_CONTEXT_WARNING } from '../tools/patch-warning.js'
import { Transcript } from '../transcript/store.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { actionOf, foldOf, parts, pieces, stepLabel } from '../view/workLogModel.js'
import { parseJson, record } from '../wire/json.js'
import { stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const tool = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: entryId(id), call: c })
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }

it('keeps actual patch warnings alongside no-write and V4A validation results in completed work', () => {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/patch-warning-combined-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const output = record(parseJson(raw))
  const noopPayload = record(output?.['noop'])
  const validationPayload = record(output?.['validation'])
  if (!noopPayload || !validationPayload) throw new Error('missing producer envelopes')
  expect(output?.['writes']).toBe(0)
  expect(noopPayload['is_error']).toBe(false)
  expect(validationPayload['is_error']).toBe(true)
  const transcript = new Transcript()
  transcript.toolComplete(stub(noopPayload), 5)
  transcript.toolComplete(stub(validationPayload), 6)
  const noop = transcript.call(toolCallId('warning-noop'))
  const validation = transcript.call(toolCallId('warning-validation'))
  if (!noop || !validation) throw new Error('missing completed calls')
  const before = tool('before', call('terminal'))
  const noopBlock = tool('noop', noop)
  const web = tool('web', call('web_extract', {}, { result: { results: [{ error: 'invalid URL' }] } }))
  const validationBlock = tool('validation', validation)
  const memory = tool('memory', call('memory', { action: 'add' }, { result: { success: true, staged: true, pending_id: '1a2b3c4d', message: 'Pending approval' } }))
  const answer: Block = { kind: 'text', id: entryId('answer'), text: 'answer' }
  const t: TurnEntry = { kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks: [before, noopBlock, web, validationBlock, memory, answer] }
  expect(parts(t).flatMap(p => p.blocks.map(b => b.id))).toEqual(['before', 'noop', 'web', 'validation', 'memory', 'answer'])
  for (const b of [noopBlock, web, validationBlock, memory]) expect(foldOf(t)?.hidden.has(b.id)).toBe(false)
  for (const b of [noopBlock, validationBlock]) expect(pieces([b])).toEqual([{ kind: 'block', block: b }])
  expect(actionOf(noop)).toBe('other')
  expect(stepLabel(noop)).toBe('Patch target appears present in x.py')
  expect(actionOf(validation)).toBe('other')
  expect(stepLabel(validation)).toBe('Patch validation failed')
  const root = tree(entryNode(t, 'main.patch-warning-integration', cx))
  const cards = nodes(root).filter(n => n.k === 'tool')
  const noopCard = cards.find(n => n.p?.['key'] === noop.id)
  const validationCard = cards.find(n => n.p?.['key'] === validation.id)
  expect(noopCard?.p).toMatchObject({ status: 'done', collapsed: false })
  expect(validationCard?.p).toMatchObject({ status: 'error', collapsed: false })
  expect(JSON.stringify(noopCard)).toContain('Target text appears present; no write performed')
  expect(JSON.stringify(validationCard)).toContain('Patch validation failed (no files were modified)')
  for (const card of [noopCard, validationCard]) {
    const text = JSON.stringify(card)
    expect(text.split(PATCH_CONTEXT_WARNING)).toHaveLength(2)
    expect(text).not.toContain('/backend/private')
    expect(text).not.toContain('sibling-secret')
  }
  const view = JSON.stringify(root)
  expect(view).toContain('Extraction failed: invalid URL')
  expect(view).toContain('memory change was staged for approval')
}, 20_000)
