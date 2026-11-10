import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { v4aValidationFailure, v4aValidationMarker } from '../tools/v4a-validation.js'
import { history } from '../transcript/history.js'
import { Transcript } from '../transcript/store.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { actionOf, foldOf, parts, pieces, stepLabel, summarize } from '../view/workLogModel.js'
import { parseJson, record } from '../wire/json.js'
import { stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const prefix = 'Patch validation failed (no files were modified):\n'
const error = `${prefix}  • x.py: hunk 1 (no hint) not found — Could not find a match for old_string in the file`
const args = { mode: 'patch', patch: '*** Begin Patch\n*** End Patch' }
const make = (result: unknown, more: Partial<ToolCall> = {}) => call('patch', args, { result, outcome: { kind: 'error', duration: 1 }, ...more })
const tool = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: entryId(id), call: c })
const text = (id: string): Block => ({ kind: 'text', id: entryId(id), text: id })
const turn = (blocks: Block[]): TurnEntry => ({ kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks })
const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }
const nodes = (n: NodeJson): NodeJson[] => [n, ...(n.c ?? []).flatMap(nodes)]
const errors = (roots: NodeJson[]) => roots.flatMap(nodes).filter(n => n.p?.['role'] === 'omp.tool.error')

function produced(): Record<string, unknown> {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/v4a-validation-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const data = record(parseJson(raw))
  if (!data) throw new Error('missing producer result')
  return data
}

describe('V4A validation refusal', () => {
  it('shows the actual pinned refusal and reason once without claiming an edit', () => {
    const data = produced()
    expect(data['writes']).toBe(0)
    const payload = record(data['payload'])
    if (!payload) throw new Error('missing gateway payload')
    expect(payload['is_error']).toBe(true)
    expect(record(payload['result'])).toMatchObject({ success: false, error })
    const store = new Transcript()
    store.toolComplete(stub(payload), 5)
    const live = store.call(toolCallId('refusal'))
    if (!live) throw new Error('missing live patch')
    expect(live.outcome.kind).toBe('error')
    expect(v4aValidationFailure(live)).toBe(error)
    expect(stepLabel(live)).toBe('Patch validation failed')
    expect(actionOf(live)).toBe('other')
    expect(summarize([tool('refusal', live)])).toBe('Used 1 tool')
    const b = tool('refusal', live)
    const t = turn([tool('before', call('terminal')), b, tool('after', call('terminal')), text('answer')])
    expect(foldOf(t)?.hidden.has(b.id)).toBe(false)
    expect(parts(t).map(p => `${p.kind}:${p.blocks.map(item => item.id).join(',')}`)).toEqual(['fold:before', 'shown:refusal', 'fold:after', 'shown:answer'])
    expect(pieces([b], t.blocks)).toEqual([{ kind: 'block', block: b }])
    const card = nodes(tree(entryNode(t, 'main.validation', cx))).find(n => n.k === 'tool' && n.p?.['name'] === 'edit')
    if (!card) throw new Error('missing direct card')
    expect(card.p).toMatchObject({ status: 'error', collapsed: false, meta: ['Patch validation failed'] })
    expect(errors([card]).map(n => n.p?.['spans'])).toEqual([[{ s: 'error', t: error }]])
    expect(errors(toolDetail(live, 0).map(tree)).map(n => n.p?.['spans'])).toEqual([[{ s: 'error', t: error }]])
    expect(nodes(card).some(n => n.k === 'diff')).toBe(false)
    expect(live.result).toBe(payload['result'])
  })

  it('shows only the retained result on replay', () => {
    const data = produced()
    const payload = record(data['payload'])
    const actualArgs = record(payload?.['args'])
    if (!payload || !actualArgs) throw new Error('missing producer payload')
    const replay = (content?: string) => history({ kept: [], id: entryId, messages: [
      { role: 'tool', name: 'patch', tool_call_id: 'saved', args: actualArgs, ...(content ? { content } : {}) },
      { role: 'assistant', text: 'answer' }
    ] }).find(e => e.kind === 'turn')
    const retained = replay(String(payload['result']))
    const absent = replay()
    if (!retained || retained.kind !== 'turn' || !absent || absent.kind !== 'turn') throw new Error('missing replay')
    const b = retained.blocks.find(item => item.kind === 'tool')
    if (b?.kind !== 'tool') throw new Error('missing replay call')
    expect(b.call.outcome.kind).toBe('error')
    expect(v4aValidationFailure(b.call)).toBe(error)
    expect(JSON.stringify(tree(entryNode(retained, 'main.replay', cx)))).toContain('no files were modified')
    expect(JSON.stringify(tree(entryNode(absent, 'main.replay', cx)))).not.toContain('no files were modified')
  })

  it('rejects contradictory or incomplete evidence without inferring an edit or no-write', () => {
    const good = { success: false, error }
    const invalid: unknown[] = [{ ...good, success: true }, { ...good, error: prefix }, { ...good, diff: 'actual diff' },
      { ...good, files_modified: ['x.py'] }, { ...good, files_created: ['a'] }, { ...good, files_deleted: ['b'] },
      { ...good, no_change: true }, { ...good, lint: { 'x.py': { status: 'error', output: 'x' } } },
      { ...good, lsp_diagnostics: 'lsp' }, { ...good, status: 'ok' }, { ...good, ok: true }, { ...good, exit_code: 0 },
      { ...good, is_error: false }, { ...good, failed: false }, { ...good, cancelled: false }, { ...good, partial: true },
      { ...good, truncated: true }, Object.assign(Object.create({ error }), { success: false })]
    for (const result of invalid) {
      const c = make(result)
      expect(v4aValidationFailure(c)).toBeUndefined()
      if (v4aValidationMarker(c)) {
        expect(stepLabel(c)).toBe('Patch failed')
        expect(actionOf(c)).toBe('other')
      }
    }
    const stale = make(good, { diff: '@@ -1 +1 @@\n-a\n+b' })
    expect(v4aValidationFailure(stale)).toBeUndefined()
    expect(stepLabel(stale)).toBe('Patch failed')
    expect(actionOf(stale)).toBe('other')
    for (const outcome of [{ kind: 'done' as const, duration: 1 }, { kind: 'running' as const }, { kind: 'cancelled' as const, duration: 1 }]) {
      expect(v4aValidationFailure(make(good, { outcome }))).toBeUndefined()
    }
    for (const other of [{}, { mode: 'replace', patch: args.patch }, { mode: 'patch' }]) {
      const c = call('patch', other, { result: good, outcome: { kind: 'error', duration: 1 } })
      expect(v4aValidationFailure(c)).toBeUndefined()
      expect(stepLabel(c)).toBe('Patch failed')
      expect(actionOf(c)).toBe('other')
    }
    expect(v4aValidationFailure(make({ success: false, error: 'Apply phase failed (state may be inconsistent — run `git diff` to assess):\n  • failed' }))).toBeUndefined()
  })

  it('preserves existing no-write behavior and bounds untrusted error text', () => {
    const noop = call('patch', { path: 'x.py' }, { result: { success: true, no_change: true } })
    expect(stepLabel(noop)).toBe('Patch target appears present in x.py')
    expect(actionOf(noop)).toBe('other')
    const unsafe = tree(toolNode(make({ success: false, error: `${prefix}bad\u001b\u2028\u206a\ud800` + 'x'.repeat(4000) }), 0))
    const data = JSON.stringify(unsafe)
    expect(data).toContain('\\\\u001b\\\\u2028\\\\u206a\\\\ud800')
    expect(data).toContain('Patch error clipped in view')
    expect(data).toContain('Patch error control characters escaped in view')
    expect(nodes(unsafe).every(n => n.p?.['href'] === undefined)).toBe(true)
  })
})
