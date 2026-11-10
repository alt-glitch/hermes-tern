import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { v4aLintNeedsAttention } from '../tools/v4a-lint.js'
import { history } from '../transcript/history.js'
import { Transcript } from '../transcript/store.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { foldOf, parts, pieces } from '../view/workLogModel.js'
import { parseJson, record } from '../wire/json.js'
import { stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const args = { mode: 'patch', patch: '*** Begin Patch\n*** End Patch' }
const prefix = 'Apply phase failed (state may be inconsistent — run `git diff` to assess):\n'
const error = `${prefix}  • Failed to update y.py: write refused`
const lint = { 'x.py': { status: 'error', output: 'SyntaxError' } }
const patch = (result: unknown, more: Partial<ToolCall> = {}) => call('patch', args, { result, outcome: { kind: 'error', duration: 1 }, ...more })
const tool = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: entryId(id), call: c })
const text = (id: string): Block => ({ kind: 'text', id: entryId(id), text: id })
const turn = (blocks: Block[]): TurnEntry => ({ kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks })
const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }
const nodes = (n: NodeJson): NodeJson[] => [n, ...(n.c ?? []).flatMap(nodes)]

/** Real pinned V4A producer and gateway envelope, using the memory-backed fixture. */
function gateway(): Record<string, unknown> {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/v4a-partial-gateway.py'), resolve('src/__tests__/fixtures/v4a-lint-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const payload = record(parseJson(raw))
  if (!payload) throw new Error('missing gateway payload')
  return payload
}

describe('V4A retained partial-failure reports', () => {
  it('preserves the real gateway failure, lint and diff visibly before the answer', () => {
    const payload = gateway()
    expect(payload['is_error']).toBe(true)
    const result = record(payload['result'])
    expect(result).toMatchObject({ success: false, error, lint: { 'x.py': { status: 'error', output: expect.stringContaining('SyntaxError') } } })
    const store = new Transcript()
    store.toolComplete(stub(payload), 5)
    const live = store.call(toolCallId('partial'))
    if (!live) throw new Error('missing live patch')
    expect(live.outcome.kind).toBe('error')
    expect(v4aLintNeedsAttention(live)).toBe(true)
    const b = tool('partial', live)
    const t = turn([tool('before', call('terminal')), b, tool('after', call('terminal')), text('answer')])
    expect(foldOf(t)?.hidden.has(b.id)).toBe(false)
    expect(parts(t).map(p => `${p.kind}:${p.blocks.map(item => item.id).join(',')}`)).toEqual(['fold:before', 'shown:partial', 'fold:after', 'shown:answer'])
    expect(pieces([b], t.blocks)).toEqual([{ kind: 'block', block: b }])
    const card = nodes(tree(entryNode(t, 'main.partial', cx))).find(n => n.k === 'tool' && n.p?.['name'] === 'edit')
    expect(card?.p).toMatchObject({ status: 'error', collapsed: false })
    expect(card && nodes(card).filter(n => n.p?.['role'] === 'omp.tool.error').map(n => n.p?.['spans'])).toEqual([[{ s: 'error', t: error }]])
    expect(JSON.stringify(card)).toContain('Failed to update y.py: write refused')
    expect(JSON.stringify(card)).toContain('Lint reported an error for x.py')
    expect(JSON.stringify(card)).toContain('SyntaxError')
    expect(nodes(card ?? tree(toolNode(live, 0))).find(n => n.k === 'diff')?.p?.['text']).toContain('def broken(:')
    const detail = toolDetail(live, 10).map(tree)
    expect(detail.flatMap(nodes).filter(n => n.p?.['role'] === 'omp.tool.error').map(n => n.p?.['spans'])).toEqual([[{ s: 'error', t: error }]])
    expect(live.result).toBe(payload['result'])
  })

  it('retains the actual partial report on replay, but not without its result', () => {
    const payload = gateway()
    const replay = (content?: string) => history({ kept: [], id: entryId, messages: [
      { role: 'tool', name: 'patch', tool_call_id: 'p', args, ...(content ? { content } : {}) },
      { role: 'assistant', text: 'answer' }
    ] }).find(e => e.kind === 'turn')
    const retained = replay(String(payload['result']))
    const absent = replay()
    if (!retained || retained.kind !== 'turn' || !absent || absent.kind !== 'turn') throw new Error('missing replay')
    const b = retained.blocks.find(x => x.kind === 'tool')
    if (b?.kind !== 'tool') throw new Error('missing replay patch')
    expect(b.call.outcome.kind).toBe('error')
    const rendered = JSON.stringify(tree(entryNode(retained, 'main.replay', cx)))
    expect(rendered).toContain('Failed to update y.py: write refused')
    expect(rendered).toContain('Lint reported an error for x.py')
    expect(JSON.stringify(tree(entryNode(absent, 'main.replay', cx)))).not.toContain('Lint reported an error for x.py')
  })

  it('keeps the bounded uninspected notice neutral while preserving the top-level error', () => {
    const entries = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`file${i}.py`, { status: 'ok', output: '' }]))
    const b = tool('partial', patch({ success: false, error, lint: entries }))
    expect(v4aLintNeedsAttention(b.call)).toBe(true)
    const card = tree(toolNode(b.call, 0))
    expect(card.p).toMatchObject({ status: 'error', collapsed: false })
    expect(JSON.stringify(card)).toContain('Additional lint entries were not inspected')
    expect(JSON.stringify(card)).toContain('Failed to update y.py: write refused')
    expect(JSON.stringify(card)).not.toContain('Lint reported an error')
  })

  it('does not infer a partial report from malformed, contradictory or missing fields', () => {
    const good = { success: false, error, lint }
    const bad: unknown[] = [undefined, {}, { ...good, success: true }, { ...good, error: 'Patch validation failed (no files were modified):\ninvalid' },
      { ...good, error: prefix }, { ...good, no_change: true }, { ...good, ok: true }, { ...good, exit_code: 0 },
      { ...good, is_error: false }, { ...good, partial: true }, { ...good, truncated: true },
      Object.assign(Object.create({ error }), { success: false, lint })]
    for (const value of bad) expect(v4aLintNeedsAttention(patch(value))).toBe(false)
    for (const outcome of [{ kind: 'done' as const, duration: 1 }, { kind: 'cancelled' as const, duration: 1 }, { kind: 'running' as const }]) {
      expect(v4aLintNeedsAttention(patch(good, { outcome }))).toBe(false)
    }
    for (const other of [{}, { mode: 'replace', patch: args.patch }, { mode: 'patch' }]) {
      expect(v4aLintNeedsAttention(call('patch', other, { result: good, outcome: { kind: 'error', duration: 1 } }))).toBe(false)
    }
  })

  it('bounds and escapes the top-level error and preserves mixed work ordering', () => {
    const bad = `${prefix}bad\u001b\u2028\u206a\ud800` + 'x'.repeat(4000)
    const b = tool('partial', patch({ success: false, error: bad, lint }))
    const t = turn([tool('before', call('terminal')), b, text('answer'), tool('after', call('terminal'))])
    expect(parts(t).flatMap(p => p.blocks.map(x => x.id))).toEqual(['before', 'partial', 'answer', 'after'])
    const card = tree(toolNode(b.call, 0))
    const rendered = JSON.stringify(card)
    expect(rendered).toContain('\\\\u001b\\\\u2028\\\\u206a\\\\ud800')
    expect(rendered).toContain('Patch error clipped in view')
    expect(rendered).toContain('Patch error control characters escaped in view')
    expect(card.p?.['status']).toBe('error')
  })
})
