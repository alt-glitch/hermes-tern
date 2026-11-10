import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { v4aLintNeedsAttention } from '../tools/v4a-lint.js'
import { history } from '../transcript/history.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { actionOf, foldOf, parts, pieces, stepLabel } from '../view/workLogModel.js'
import { parseJson, record } from '../wire/json.js'
import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const args = { mode: 'patch', patch: '*** Begin Patch\n*** End Patch' }
const patch = (result: unknown, more: Partial<ToolCall> = {}) => call('patch', args, { result, ...more })
const tool = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: entryId(id), call: c })
const text = (id: string): Block => ({ kind: 'text', id: entryId(id), text: id })
const turn = (blocks: Block[]): TurnEntry => ({ kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks })
const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]

function producer(): Record<string, unknown>[] {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/v4a-lint-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const data = parseJson(raw)
  if (!Array.isArray(data)) throw new Error('missing producer results')
  return data.map(value => { const result = record(value); if (!result) throw new Error('invalid producer result'); return result })
}

describe('V4A lint attention in work folds', () => {
  it('shows the retained pinned producer error before the answer without changing the result', () => {
    const [result] = producer()
    if (!result) throw new Error('missing V4A result')
    const b = tool('patch', patch(result))
    const t = turn([tool('before', call('terminal')), b, tool('after', call('terminal')), text('answer')])
    expect(v4aLintNeedsAttention(b.call)).toBe(true)
    expect(foldOf(t)?.hidden.has(b.id)).toBe(false)
    expect(parts(t).map(p => `${p.kind}:${p.blocks.map(item => item.id).join(',')}`))
      .toEqual(['fold:before', 'shown:patch', 'fold:after', 'shown:answer'])
    expect(pieces([b], t.blocks)).toEqual([{ kind: 'block', block: b }])
    const card = nodes(tree(entryNode(t, 'main.v4a', cx))).find(node => node.k === 'tool' && node.p?.['name'] === 'edit')
    expect(card?.p).toMatchObject({ status: 'done', collapsed: false })
    expect(JSON.stringify(card)).toContain('Lint reported an error for x.py')
    expect(JSON.stringify(card)).toContain('SyntaxError')
    expect(JSON.stringify(card)).not.toContain('Lint reported an error for y.py')
    expect(b.call.result).toBe(result)
    expect(b.call.outcome.kind).toBe('done')
  })

  it('promotes the bounded-scan omission notice without inventing a lint error', () => {
    const lint = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`file${i}.py`, { status: 'ok', output: '' }]))
    const b = tool('patch', patch({ success: true, lint }))
    const t = turn([tool('before', call('terminal')), b, text('answer')])
    expect(v4aLintNeedsAttention(b.call)).toBe(true)
    expect(foldOf(t)?.hidden.has(b.id)).toBe(false)
    const card = nodes(tree(entryNode(t, 'main.limit', cx))).find(node => node.k === 'tool' && node.p?.['name'] === 'edit')
    expect(card?.p).toMatchObject({ status: 'done', collapsed: false })
    expect(JSON.stringify(card)).toContain('Additional lint entries were not inspected')
    expect(JSON.stringify(card)).not.toContain('Lint reported an error')
  })

  it('retains write, replace, no-write, web, delegate and eval work in order', () => {
    const [result] = producer()
    const noop = tool('noop', call('patch', { path: 'x.py' }, { result: { success: true, no_change: true } }))
    const web = tool('web', call('web_extract', {}, { result: { results: [{ error: 'invalid URL' }] } }))
    const task = tool('task', call('delegate_task', {}, { result: { results: [{ status: 'completed', exit_reason: 'max_iterations', truncated: true, summary: 'partial' }] } }))
    const evalBlock = tool('eval', call('execute_code', {}, { result: { stdout_truncated: true, output: 'partial' } }))
    const write = tool('write', call('write_file', { path: 'w.py', content: 'x' }, { result: { lint: { status: 'error', output: 'write problem' } } }))
    const replace = tool('replace', call('patch', { path: 'r.py', old_string: 'x', new_string: 'y' }, { result: { success: true, lint: { status: 'error', output: 'replace problem' } } }))
    const b = tool('v4a', patch(result))
    const t = turn([noop, web, task, evalBlock, write, replace, b, text('answer')])
    expect(parts(t).flatMap(p => p.blocks.map(item => item.id))).toEqual(['noop', 'web', 'task', 'eval', 'write', 'replace', 'v4a', 'answer'])
    expect([web, task, evalBlock, write, replace, b].map(item => foldOf(t)?.hidden.has(item.id))).toEqual([false, false, false, false, false, false])
    expect(actionOf(noop.call)).toBe('other')
    expect(stepLabel(noop.call)).toBe('Patch target appears present in x.py')
    const rendered = JSON.stringify(tree(entryNode(t, 'main.mixed', cx)))
    for (const value of ['Target text appears present; no write performed', 'At least one delegated task reached its iteration limit',
      'Hermes reports stdout was truncated', 'write problem', 'replace problem', 'Lint reported an error for x.py']) expect(rendered).toContain(value)
  })

  it('does not promote clean, partial, malformed, unrelated, no-op or non-done results', () => {
    const [good, partial, overwritten] = producer()
    const report = { status: 'error', output: 'syntax' }
    const cases: unknown[] = [undefined, {}, partial, overwritten, { success: true, no_change: true, lint: { a: report } },
      { success: true, partial: true, lint: { a: report } }, { success: true, lint: { a: { status: 'error', output: 4 } } }]
    for (const result of cases) {
      const b = tool('patch', patch(result))
      expect(v4aLintNeedsAttention(b.call)).toBe(false)
      expect(foldOf(turn([b, text('answer')]))?.hidden.has(b.id)).toBe(true)
    }
    expect(v4aLintNeedsAttention(call('write_file', args, { result: good }))).toBe(false)
    for (const outcome of [{ kind: 'error' as const, duration: 1 }, { kind: 'cancelled' as const, duration: 1 }, { kind: 'running' as const }]) {
      const b = tool('patch', patch(good, { outcome }))
      expect(v4aLintNeedsAttention(b.call)).toBe(false)
      const card = tree(entryNode(turn([b, text('answer')]), 'main.outcome', cx))
      expect(JSON.stringify(card)).not.toContain('Lint reported an error for x.py')
      expect(b.call.outcome).toEqual(outcome)
    }
  })

  it('shows retained replay data only and fails closed on a throwing lint getter', () => {
    const [result] = producer()
    const replay = (content?: string) => history({ kept: [], id: entryId, messages: [
      { role: 'tool', name: 'patch', tool_call_id: 'p', args, ...(content ? { content } : {}) },
      { role: 'assistant', text: 'answer' }
    ] }).find(e => e.kind === 'turn')
    const retained = replay(JSON.stringify(result))
    const absent = replay()
    if (!retained || retained.kind !== 'turn' || !absent || absent.kind !== 'turn') throw new Error('missing replay')
    expect(JSON.stringify(tree(entryNode(retained, 'main.replay', cx)))).toContain('Lint reported an error for x.py')
    expect(JSON.stringify(tree(entryNode(absent, 'main.replay', cx)))).not.toContain('Lint reported an error')
    const bad: Record<string, unknown> = { success: true }
    Object.defineProperty(bad, 'lint', { enumerable: true, get: () => { throw new Error('bad lint') } })
    const b = tool('bad', patch(bad, { resultText: 'safe retained result' }))
    expect(v4aLintNeedsAttention(b.call)).toBe(false)
    expect(foldOf(turn([b, text('answer')]))?.hidden.has(b.id)).toBe(true)
  })
})
