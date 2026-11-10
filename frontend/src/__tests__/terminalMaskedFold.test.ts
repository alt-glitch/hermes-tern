import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { history } from '../transcript/history.js'
import { Transcript } from '../transcript/store.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { foldOf, parts, pieces } from '../view/workLogModel.js'
import { parseJson, record } from '../wire/json.js'
import { stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const warning = 'Hermes reports that exit 0 may mask a failure in an earlier command.'
const tool = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: entryId(id), call: c })
const text = (id: string): Block => ({ kind: 'text', id: entryId(id), text: id })
const turn = (blocks: Block[]): TurnEntry => ({ kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks })
const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const make = (result: unknown, more: Partial<ToolCall> = {}) => call('terminal', { command: 'npm test | tail' }, { result, ...more })

function producer(): Record<string, unknown>[] {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/terminal-masked-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const data = parseJson(raw)
  if (!Array.isArray(data)) throw new Error('expected producer results')
  return data.map(value => { const row = record(value); if (!row) throw new Error('invalid result'); return row })
}

describe('masked terminal advisory attention', () => {
  it('shows both actual producer signals as direct unfolded cards at their original positions', () => {
    const data = producer()
    for (const result of data.slice(0, 2)) {
      const b = tool('masked', make(result))
      const t = turn([tool('before', call('terminal')), b, tool('after', call('terminal')), text('answer')])
      expect(foldOf(t)?.hidden.has(b.id)).toBe(false)
      expect(parts(t).map(p => `${p.kind}:${p.blocks.map(x => x.id).join(',')}`)).toEqual(['fold:before', 'shown:masked', 'fold:after', 'shown:answer'])
      expect(pieces([b])).toEqual([{ kind: 'block', block: b }])
      const card = nodes(tree(entryNode(t, 'main.masked', cx))).find(n => n.k === 'tool' && n.p?.['name'] === 'bash')
      expect(card?.p).toMatchObject({ collapsed: false, exit: 0, status: 'done' })
      expect(JSON.stringify(card)).toContain(warning)
      expect(b.call.result).toBe(result)
    }
  })

  it('preserves recreation and web, delegate, eval, error and running attention in order', () => {
    const both = producer()[2]
    const web = tool('web', call('web_extract', {}, { result: { results: [{ error: 'failed' }] } }))
    const task = tool('task', call('delegate_task', {}, { result: { results: [{ status: 'completed', exit_reason: 'max_iterations', truncated: true, summary: 'partial' }] } }))
    const evalBlock = tool('eval', call('execute_code', {}, { result: { stdout_truncated: true, output: 'partial' } }))
    const b = tool('both', make(both))
    const failed = tool('failed', call('terminal', {}, { outcome: { kind: 'error', duration: 1 } }))
    const running = tool('running', call('terminal', {}, { outcome: { kind: 'running' } }))
    const t = turn([tool('before', call('terminal')), web, task, evalBlock, b, failed, text('answer'), running])
    expect(parts(t).flatMap(p => p.blocks.map(x => x.id))).toEqual(['before', 'web', 'task', 'eval', 'both', 'failed', 'answer', 'running'])
    expect([web, task, evalBlock, b, failed, running].map(x => foldOf(t)?.hidden.has(x.id))).toEqual([false, false, false, false, false, false])
    const root = JSON.stringify(tree(entryNode(t, 'main.combined', cx)))
    expect(root).toContain(warning)
    expect(root).toContain('background processes and unpersisted files may be lost')
    expect(root).toContain('Hermes reports stdout was truncated')
    expect(root).toContain('At least one delegated task reached its iteration limit')
  })

  it('does not promote clean, malformed, contradictory or non-done calls', () => {
    const data = producer()
    const result = data[0]
    if (!result) throw new Error('missing result')
    const cases = [undefined, data[3], data[4], { ...result, hint: 'other' }, { ...result, exit_code: 1 },
      { ...result, status: 'error' }, { ...result, session_id: 4 }, { ...result, error: 'failure' }]
    for (const value of cases) {
      const b = tool('ordinary', make(value))
      expect(foldOf(turn([b, text('answer')]))?.hidden.has(b.id)).toBe(true)
      expect(pieces([b])).toEqual([{ kind: 'work', items: [b] }])
    }
    const broken = Object.defineProperty({}, 'command', { get: () => { throw new Error('bad args') }, enumerable: true })
    expect(foldOf(turn([tool('broken', call('terminal', broken)), text('answer')]))).toBeDefined()
    for (const outcome of [{ kind: 'running' as const }, { kind: 'error' as const, duration: 1 }, { kind: 'cancelled' as const, duration: 1 }]) {
      const b = tool('ordinary', make(result, { outcome }))
      expect(JSON.stringify(tree(entryNode(turn([b, text('answer')]), 'main.control', cx)))).not.toContain(warning)
      expect(b.call.outcome).toEqual(outcome)
    }
  })

  it('promotes the real canonical completion and retained replay, not an absent replay result', () => {
    const data = producer()
    const event = data[5]
    if (!event || typeof event['result'] !== 'string') throw new Error('missing event')
    const live = new Transcript()
    live.toolComplete(stub(event), 1)
    const liveCall = live.call(toolCallId('c1'))
    if (!liveCall) throw new Error('missing live call')
    expect(foldOf(turn([tool('live', liveCall), text('answer')]))?.hidden.has('live')).not.toBe(true)
    const replay = (content?: string) => history({ kept: [], id: entryId, messages: [
      { role: 'tool', name: 'terminal', tool_call_id: 'term', args: { command: 'npm test | tail' }, ...(content ? { content } : {}) },
      { role: 'assistant', text: 'answer' }
    ] }).find(e => e.kind === 'turn')
    const retained = replay(event['result'])
    const absent = replay()
    if (!retained || retained.kind !== 'turn' || !absent || absent.kind !== 'turn') throw new Error('missing replay')
    const kept = retained.blocks.find(b => b.kind === 'tool')
    const lost = absent.blocks.find(b => b.kind === 'tool')
    expect(kept && foldOf(retained)?.hidden.has(kept.id)).not.toBe(true)
    expect(lost && foldOf(absent)?.hidden.has(lost.id)).toBe(true)
    expect(JSON.stringify(tree(entryNode(retained, 'main.replay', cx)))).toContain(warning)
    expect(JSON.stringify(tree(entryNode(absent, 'main.replay', cx)))).not.toContain(warning)
  })
})
