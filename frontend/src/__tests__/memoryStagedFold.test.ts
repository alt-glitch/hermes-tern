import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { history } from '../transcript/history.js'
import { Transcript } from '../transcript/store.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { actionOf, foldOf, parts, pieces, stepLabel } from '../view/workLogModel.js'
import { parseJson, record } from '../wire/json.js'
import { stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const notice = 'Hermes reported this memory change was staged for approval; application was not confirmed.'
const tool = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: entryId(id), call: c })
const text = (id: string): Block => ({ kind: 'text', id: entryId(id), text: id })
const turn = (blocks: Block[]): TurnEntry => ({ kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks })
const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const staged = { success: true, staged: true, pending_id: '1a2b3c4d', message: 'Pending approval' }
const make = (result: unknown, more: Partial<ToolCall> = {}) => call('memory', { action: 'add' }, { result, ...more })

function producer(): Record<string, unknown>[] {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/memory-staged-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src'), PYTHONDONTWRITEBYTECODE: '1' }
  })
  const data = parseJson(raw)
  if (!Array.isArray(data)) throw new Error('expected gateway payloads')
  return data.map(item => { const r = record(item); if (!r) throw new Error('invalid gateway payload'); return r })
}

describe('historical memory staging attention', () => {
  it('shows both pinned staging reports before the answer, without changing their results or status', () => {
    for (const payload of producer()) {
      const transcript = new Transcript()
      transcript.toolComplete(stub(payload), 10)
      const c = transcript.call(toolCallId(String(payload['tool_id'])))
      if (!c) throw new Error('missing memory call')
      const b = tool('memory', c)
      const t = turn([tool('before', call('terminal')), b, tool('after', call('terminal')), text('answer')])
      expect(foldOf(t)?.hidden.has(b.id)).toBe(false)
      expect(parts(t).map(p => `${p.kind}:${p.blocks.map(x => x.id).join(',')}`)).toEqual(['fold:before', 'shown:memory', 'fold:after', 'shown:answer'])
      expect(pieces([b], t.blocks)).toEqual([{ kind: 'block', block: b }])
      const card = nodes(tree(entryNode(t, 'main.memory', cx))).find(n => n.k === 'tool' && n.p?.['name'] === 'memory')
      expect(card?.p).toMatchObject({ status: 'done', collapsed: false, meta: ['Staging reported'] })
      expect(JSON.stringify(card)).toContain(notice)
      expect(JSON.stringify(card)).not.toContain('1a2b3c4d')
      expect(c.outcome.kind).toBe('done')
      expect(c.result).toBe(payload['result'])
    }
  })

  it('keeps existing web, delegate, eval and no-write semantics in order', () => {
    const noop = tool('noop', call('patch', { path: 'a.py' }, { result: { success: true, no_change: true } }))
    const web = tool('web', call('web_extract', {}, { result: { results: [{ error: 'invalid URL' }] } }))
    const task = tool('task', call('delegate_task', {}, { result: { results: [{ status: 'completed', exit_reason: 'max_iterations', truncated: true, summary: 'partial' }] } }))
    const evalBlock = tool('eval', call('execute_code', {}, { result: { stdout_truncated: true, output: 'partial' } }))
    const b = tool('memory', make(staged))
    const failed = tool('failed', call('terminal', {}, { outcome: { kind: 'error', duration: 1 } }))
    const running = tool('running', call('terminal', {}, { outcome: { kind: 'running' } }))
    const t = turn([noop, web, task, evalBlock, b, failed, text('answer'), running])
    expect(parts(t).flatMap(p => p.blocks.map(x => x.id))).toEqual(['noop', 'web', 'task', 'eval', 'memory', 'failed', 'answer', 'running'])
    expect([web, task, evalBlock, b, failed, running].map(x => foldOf(t)?.hidden.has(x.id))).toEqual([false, false, false, false, false, false])
    expect(actionOf(noop.call)).toBe('other')
    expect(stepLabel(noop.call)).toBe('Patch target appears present in a.py')
    const rendered = JSON.stringify(tree(entryNode(t, 'main.combined', cx)))
    expect(rendered).toContain(notice)
    expect(rendered).toContain('At least one delegated task reached its iteration limit')
    expect(rendered).toContain('Hermes reports stdout was truncated')
    expect(rendered).toContain('Target text appears present; no write performed')
  })

  it('does not promote clean, malformed, contradictory or non-done reports', () => {
    const cases: unknown[] = [undefined, {}, { ...staged, staged: false }, { ...staged, applied: true }, { ...staged, pending_id: 'bad' }]
    for (const result of cases) {
      const b = tool('memory', make(result))
      expect(foldOf(turn([b, text('answer')]))?.hidden.has(b.id)).toBe(true)
      expect(pieces([b])).toEqual([{ kind: 'work', items: [b] }])
    }
    for (const outcome of [{ kind: 'running' as const }, { kind: 'error' as const, duration: 1 }, { kind: 'cancelled' as const, duration: 1 }]) {
      const b = tool('memory', make(staged, { outcome }))
      expect(JSON.stringify(tree(entryNode(turn([b, text('answer')]), 'main.control', cx)))).not.toContain(notice)
      expect(b.call.outcome).toEqual(outcome)
    }
    const invalid: Record<string, unknown> = { success: true }
    Object.defineProperty(invalid, 'staged', { enumerable: true, get: () => { throw new Error('bad result') } })
    const b = tool('bad', make(invalid))
    expect(foldOf(turn([b, text('answer')]))?.hidden.has(b.id)).toBe(true)
  })

  it('promotes retained history only', () => {
    const payload = producer()[0]
    if (!payload) throw new Error('missing payload')
    const args = record(payload['args'])
    if (!args) throw new Error('missing args')
    const replay = (content?: string) => history({ kept: [], id: entryId, messages: [
      { role: 'tool', name: 'memory', tool_call_id: 'memory', args, ...(content ? { content } : {}) },
      { role: 'assistant', text: 'answer' }
    ] }).find(e => e.kind === 'turn')
    const retained = replay(String(payload['result']))
    const absent = replay()
    if (!retained || retained.kind !== 'turn' || !absent || absent.kind !== 'turn') throw new Error('missing replay')
    expect(JSON.stringify(tree(entryNode(retained, 'main.replay', cx)))).toContain(notice)
    expect(JSON.stringify(tree(entryNode(absent, 'main.replay', cx)))).not.toContain(notice)
  })
})
