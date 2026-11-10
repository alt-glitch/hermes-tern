import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { patchLintNeedsAttention } from '../tools/patch-lint-attention.js'
import { history } from '../transcript/history.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { actionOf, foldOf, parts, pieces, stepLabel } from '../view/workLogModel.js'
import { parseJson, record } from '../wire/json.js'
import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const args = { path: 'x.py', old_string: 'x = 1', new_string: 'def broken(:' }
const notice = 'Lint reported an error'
const patch = (result: unknown, more: Partial<ToolCall> = {}) => call('patch', args, { result, ...more })
const tool = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: entryId(id), call: c })
const text = (id: string): Block => ({ kind: 'text', id: entryId(id), text: id })
const turn = (blocks: Block[]): TurnEntry => ({ kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks })
const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]

function producer(): Record<string, unknown> {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/patch-lint-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const data = parseJson(raw)
  if (!Array.isArray(data)) throw new Error('expected result array')
  const result = record(data[0])
  if (!result) throw new Error('missing replace result')
  return result
}

describe('replace patch lint attention in work folds', () => {
  it('shows a pinned producer diagnostic before the answer without changing the patch result', () => {
    const result = producer()
    const b = tool('patch', patch(result))
    const t = turn([tool('before', call('terminal')), b, tool('after', call('terminal')), text('answer')])
    expect(patchLintNeedsAttention(b.call)).toBe(true)
    expect(foldOf(t)?.hidden.has(b.id)).toBe(false)
    expect(parts(t).map(p => `${p.kind}:${p.blocks.map(item => item.id).join(',')}`))
      .toEqual(['fold:before', 'shown:patch', 'fold:after', 'shown:answer'])
    expect(pieces([b], t.blocks)).toEqual([{ kind: 'block', block: b }])
    const card = nodes(tree(entryNode(t, 'main.patch-lint', cx))).find(node => node.k === 'tool' && node.p?.['name'] === 'edit')
    expect(card?.p).toMatchObject({ status: 'done', collapsed: false })
    expect(JSON.stringify(card)).toContain(notice)
    expect(JSON.stringify(card)).toContain('SyntaxError')
    if (!card) throw new Error('missing patch card')
    expect(nodes(card).find(node => node.k === 'diff')?.p?.['text']).toContain('def broken(:')
    expect(b.call.result).toBe(result)
    expect(b.call.outcome.kind).toBe('done')
  })

  it('preserves no-write, write-lint, web, delegate and eval attention in mixed work', () => {
    const noop = tool('noop', patch({ success: true, no_change: true, lint: { status: 'error', output: 'ignored' } }))
    const web = tool('web', call('web_extract', {}, { result: { results: [{ error: 'invalid URL' }] } }))
    const task = tool('task', call('delegate_task', {}, { result: { results: [{ status: 'completed', exit_reason: 'max_iterations', truncated: true, summary: 'partial' }] } }))
    const evalBlock = tool('eval', call('execute_code', {}, { result: { stdout_truncated: true, output: 'partial' } }))
    const write = tool('write', call('write_file', { path: 'other.py', content: 'x' }, { result: { lint: { status: 'error', output: 'write diagnostic' } } }))
    const b = tool('patch', patch(producer()))
    const t = turn([noop, web, task, evalBlock, write, b, text('answer')])
    expect(parts(t).flatMap(p => p.blocks.map(item => item.id))).toEqual(['noop', 'web', 'task', 'eval', 'write', 'patch', 'answer'])
    expect([web, task, evalBlock, write, b].map(item => foldOf(t)?.hidden.has(item.id))).toEqual([false, false, false, false, false])
    expect(patchLintNeedsAttention(noop.call)).toBe(false)
    expect(actionOf(noop.call)).toBe('other')
    expect(stepLabel(noop.call)).toBe('Patch target appears present in x.py')
    const rendered = JSON.stringify(tree(entryNode(t, 'main.mixed', cx)))
    expect(rendered).toContain('Target text appears present; no write performed')
    expect(rendered).toContain('At least one delegated task reached its iteration limit')
    expect(rendered).toContain('Hermes reports stdout was truncated')
    expect(rendered).toContain('write diagnostic')
    expect(rendered).toContain('SyntaxError')
  })

  it('does not promote V4A, missing, malformed, partial, no-write or unrelated reports', () => {
    const lint = { status: 'error', output: 'syntax' }
    const results: unknown[] = [undefined, {}, { success: true, no_change: true, lint },
      { success: true, partial: true, lint }, { success: true, truncated: true, lint },
      { success: true, lint: { status: 'ok', output: '' } }, { success: true, lint: { status: 'error', output: 1 } },
      { success: true, lint: { 'x.py': lint } }, { success: false, lint }]
    for (const result of results) {
      const b = tool('patch', patch(result))
      expect(patchLintNeedsAttention(b.call)).toBe(false)
      expect(foldOf(turn([b, text('answer')]))?.hidden.has(b.id)).toBe(true)
    }
    const v4a = call('patch', { patch: '*** Begin Patch\n*** End Patch', mode: 'patch' }, { result: { success: true, lint: { 'x.py': lint } } })
    expect(patchLintNeedsAttention(v4a)).toBe(false)
    expect(patchLintNeedsAttention(call('write_file', args, { result: { success: true, lint } }))).toBe(false)
  })

  it('preserves settled error/cancelled outcomes, and does not promote an early running signal', () => {
    const result = producer()
    for (const outcome of [{ kind: 'error' as const, duration: 1 }, { kind: 'cancelled' as const, duration: 1 }]) {
      const b = tool('patch', patch(result, { outcome }))
      const t = turn([tool('before', call('terminal')), b, text('answer')])
      expect(patchLintNeedsAttention(b.call)).toBe(true)
      expect(foldOf(t)?.hidden.has(b.id)).toBe(false)
      const card = nodes(tree(entryNode(t, 'main.settled', cx))).find(node => node.k === 'tool' && node.p?.['name'] === 'edit')
      expect(card?.p).toMatchObject({ status: outcome.kind, collapsed: false })
      expect(JSON.stringify(card)).toContain(notice)
      expect(b.call.outcome).toEqual(outcome)
    }
    const running = tool('running', patch(result, { outcome: { kind: 'running' } }))
    expect(patchLintNeedsAttention(running.call)).toBe(false)
    expect(foldOf(turn([running, text('answer')]))?.hidden.has(running.id)).not.toBe(true)
    expect(JSON.stringify(tree(entryNode(turn([running, text('answer')]), 'main.running', cx)))).not.toContain(notice)
  })

  it('replays only retained lint, and handles a throwing details getter without breaking the fold', () => {
    const replay = (content?: string) => history({ kept: [], id: entryId, messages: [
      { role: 'tool', name: 'patch', tool_call_id: 'p', args, ...(content ? { content } : {}) },
      { role: 'assistant', text: 'answer' }
    ] }).find(e => e.kind === 'turn')
    const retained = replay(JSON.stringify(producer()))
    const absent = replay()
    if (!retained || retained.kind !== 'turn' || !absent || absent.kind !== 'turn') throw new Error('missing replay')
    expect(JSON.stringify(tree(entryNode(retained, 'main.replay', cx)))).toContain(notice)
    expect(JSON.stringify(tree(entryNode(absent, 'main.replay', cx)))).not.toContain(notice)
    const bad: Record<string, unknown> = { success: true }
    Object.defineProperty(bad, 'lint', { enumerable: true, get: () => { throw new Error('bad lint') } })
    const b = tool('bad', patch(bad, { resultText: 'safe retained result' }))
    expect(patchLintNeedsAttention(b.call)).toBe(false)
    expect(foldOf(turn([b, text('answer')]))?.hidden.has(b.id)).toBe(true)
  })
})
