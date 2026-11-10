import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { evalNeedsAttention } from '../tools/eval-attention.js'
import { history } from '../transcript/history.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { actionOf, foldOf, parts, pieces, stepLabel, summarize } from '../view/workLogModel.js'
import { parseJson } from '../wire/json.js'
import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const notice = 'Hermes reports stdout was truncated'
const evalCall = (result: unknown, more: Partial<ToolCall> = {}) => call('execute_code', { code: 'print(1)' }, { result, ...more })
const tool = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: entryId(id), call: c })
const text = (id: string): Block => ({ kind: 'text', id: entryId(id), text: id })
const turn = (blocks: Block[]): TurnEntry => ({ kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks })
const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]

function producerResult(): unknown {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/eval-truncation-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const data = parseJson(raw)
  if (!Array.isArray(data)) throw new Error('expected producer results')
  return data[0]
}

describe('retained stdout truncation attention', () => {
  it('exposes the real producer signal in place before the answer without changing output or outcome', () => {
    const result = producerResult()
    const script = tool('script', evalCall(result))
    const t = turn([tool('before', call('terminal')), script, tool('after', call('terminal')), text('answer')])
    expect(evalNeedsAttention(script.call)).toBe(true)
    expect(foldOf(t)?.hidden.has(script.id)).toBe(false)
    expect(parts(t).map(p => `${p.kind}:${p.blocks.map(b => b.id).join(',')}`)).toEqual(['fold:before', 'shown:script', 'fold:after', 'shown:answer'])
    expect(pieces([script], t.blocks)).toEqual([{ kind: 'block', block: script }])
    const root = tree(entryNode(t, 'main.eval', cx))
    const card = nodes(root).find(n => n.k === 'tool' && n.p?.['name'] === 'eval')
    expect(card?.p?.['status']).toBe('done')
    expect(card?.p?.['collapsed']).toBe(false)
    expect(JSON.stringify(card)).toContain(notice)
    expect(script.call.result).toBe(result)
    expect(script.call.outcome.kind).toBe('done')
  })

  it('preserves order and the prior web, delegate, error and running attention', () => {
    const web = tool('web', call('web_extract', {}, { result: { results: [{ error: 'failed' }] } }))
    const delegated = tool('delegated', call('delegate_task', {}, { result: { results: [{ status: 'completed', exit_reason: 'max_iterations', truncated: true, summary: 'partial' }] } }))
    const failed = tool('failed', call('terminal', {}, { outcome: { kind: 'error', duration: 1 } }))
    const running = tool('running', call('terminal', {}, { outcome: { kind: 'running' } }))
    const script = tool('script', evalCall({ stdout_truncated: true, output: 'partial' }))
    const t = turn([tool('before', call('terminal')), web, delegated, failed, script, text('answer'), running])
    expect(parts(t).flatMap(p => p.blocks.map(b => b.id))).toEqual(['before', 'web', 'delegated', 'failed', 'script', 'answer', 'running'])
    expect([web, delegated, failed, script, running].map(b => foldOf(t)?.hidden.has(b.id))).toEqual([false, false, false, false, false])
  })

  it('shows eval, web and delegate disclosures together while preserving patch no-write summaries', () => {
    const noop = tool('noop', call('patch', { path: 'file.py' }, { result: { success: true, no_change: true } }))
    const web = tool('web', call('web_extract', {}, { result: { results: [{ error: 'invalid URL' }] } }))
    const script = tool('script', evalCall(producerResult()))
    const delegated = tool('delegated', call('delegate_task', {}, { result: { results: [{ status: 'completed', exit_reason: 'max_iterations', truncated: true, summary: 'partial' }] } }))
    const changed = tool('changed', call('patch', { path: 'other.py' }, { result: { success: true, diff: '@@ -1 +1 @@\n-old\n+new' } }))
    const t = turn([noop, web, script, delegated, changed, text('answer')])
    expect(parts(t).map(part => `${part.kind}:${part.blocks.map(block => block.id).join(',')}`))
      .toEqual(['fold:noop', 'shown:web,script,delegated', 'fold:changed', 'shown:answer'])
    expect([web, script, delegated].map(block => foldOf(t)?.hidden.has(block.id))).toEqual([false, false, false])
    expect(actionOf(noop.call)).toBe('other')
    expect(stepLabel(noop.call)).toBe('Patch target appears present in file.py')
    expect(summarize([noop, changed])).toBe('Used 1 tool and changed 1 file')
    const root = tree(entryNode(t, 'main.combined', cx))
    const cards = nodes(root).filter(node => node.k === 'tool')
    const webCard = cards.find(node => node.p?.['name'] === 'fetch')
    const evalCard = cards.find(node => node.p?.['name'] === 'eval')
    const taskCard = cards.find(node => node.p?.['name'] === 'task')
    for (const card of [webCard, evalCard, taskCard]) expect(card?.p).toMatchObject({ status: 'done', collapsed: false })
    expect(JSON.stringify(webCard)).toContain('Extraction failed: invalid URL')
    expect(JSON.stringify(evalCard)).toContain(notice)
    expect(JSON.stringify(taskCard)).toContain('At least one delegated task reached its iteration limit')
    expect(JSON.stringify(root)).toContain('Target text appears present; no write performed')
    expect(JSON.stringify(root)).not.toContain('changed 2 files')
  })

  it('keeps clean, missing, malformed and contradictory signals folded', () => {
    const cases: unknown[] = [undefined, {}, { stdout_truncated: false }, { stdout_truncated: 'true' },
      { stdout_truncated: true, stdout_bytes_omitted: 0 }, { stdout_truncated: true, stdout_bytes_omitted: '2' },
      { stdout_truncated: true, stdout_bytes_captured: 2, stdout_bytes_total: 2 },
      { stdout_truncated: true, stdout_bytes_captured: 2, stdout_bytes_total: 4, stdout_bytes_omitted: 1 },
      Object.create({ stdout_truncated: true })]
    for (const result of cases) {
      const script = tool('script', evalCall(result))
      expect(evalNeedsAttention(script.call)).toBe(false)
      expect(foldOf(turn([script, text('answer')]))?.hidden.has(script.id)).toBe(true)
    }
    expect(evalNeedsAttention(call('terminal', {}, { result: { stdout_truncated: true } }))).toBe(false)
  })

  it('exposes validated settled failures and cancellations without changing their status', () => {
    for (const outcome of [{ kind: 'error' as const, duration: 1 }, { kind: 'cancelled' as const, duration: 1 }]) {
      const script = tool('script', evalCall({ stdout_truncated: true, output: 'partial' }, { outcome }))
      const t = turn([tool('before', call('terminal')), script, text('answer')])
      expect(evalNeedsAttention(script.call)).toBe(true)
      expect(foldOf(t)?.hidden.has(script.id)).toBe(false)
      expect(pieces([script])).toEqual([{ kind: 'block', block: script }])
      const card = nodes(tree(entryNode(t, 'main.settled', cx))).find(n => n.k === 'tool' && n.p?.['name'] === 'eval')
      expect(card?.p?.['status']).toBe(outcome.kind)
      expect(card?.p?.['collapsed']).toBe(false)
      expect(JSON.stringify(card)).toContain(notice)
      expect(script.call.outcome).toEqual(outcome)
    }
  })

  it('leaves running and ordinary failure or cancellation behavior intact', () => {
    const running = tool('running', evalCall({ stdout_truncated: true }, { outcome: { kind: 'running' } }))
    expect(evalNeedsAttention(running.call)).toBe(false)
    expect(foldOf(turn([running, text('answer')]))?.hidden.has(running.id)).not.toBe(true)
    expect(pieces([running])).toEqual([{ kind: 'work', items: [running] }])
    const failed = tool('failed', evalCall({}, { outcome: { kind: 'error', duration: 1 } }))
    expect(evalNeedsAttention(failed.call)).toBe(false)
    expect(foldOf(turn([failed, text('answer')]))?.hidden.has(failed.id)).not.toBe(true)
    expect(pieces([failed])).toEqual([{ kind: 'work', items: [failed] }])
    const cancelled = tool('cancelled', evalCall({}, { outcome: { kind: 'cancelled', duration: 1 } }))
    expect(evalNeedsAttention(cancelled.call)).toBe(false)
    expect(foldOf(turn([cancelled, text('answer')]))?.hidden.has(cancelled.id)).toBe(true)
  })

  it('shows only a retained replay result, not a missing result', () => {
    const replay = (content?: string) => history({ kept: [], id: entryId, messages: [
      { role: 'tool', name: 'execute_code', tool_call_id: 'eval', args: { code: 'print(1)' }, ...(content ? { content } : {}) },
      { role: 'assistant', text: 'answer' }
    ] }).find(e => e.kind === 'turn')
    const retained = replay(JSON.stringify(producerResult()))
    const absent = replay()
    if (!retained || retained.kind !== 'turn' || !absent || absent.kind !== 'turn') throw new Error('missing replay')
    const kept = retained.blocks.find(b => b.kind === 'tool')
    const lost = absent.blocks.find(b => b.kind === 'tool')
    expect(kept && foldOf(retained)?.hidden.has(kept.id)).not.toBe(true)
    expect(lost && foldOf(absent)?.hidden.has(lost.id)).toBe(true)
    expect(JSON.stringify(tree(entryNode(retained, 'main.replay', cx)))).toContain(notice)
    expect(JSON.stringify(tree(entryNode(absent, 'main.replay', cx)))).not.toContain(notice)
  })
})
