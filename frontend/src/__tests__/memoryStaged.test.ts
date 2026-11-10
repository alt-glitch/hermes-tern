import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { ToolCall } from '../model.js'
import { memoryStagingReported } from '../tools/memory-staged.js'
import { history } from '../transcript/history.js'
import { Transcript } from '../transcript/store.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { parseJson, record } from '../wire/json.js'
import { stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const notice = 'Hermes reported this memory change was staged for approval; application was not confirmed.'
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const reports = (root: NodeJson) => nodes(root).filter(n => n.p?.['role'] === 'omp.tool.notice' && n.p?.['text'] === notice)
const make = (result: unknown, more: Partial<ToolCall> = {}) => call('memory', { action: 'add' }, { result, ...more })

function producer(): Record<string, unknown>[] {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/memory-staged-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src'), PYTHONDONTWRITEBYTECODE: '1' }
  })
  const data = parseJson(raw)
  if (!Array.isArray(data)) throw new Error('expected gateway payloads')
  return data.map(item => { const r = record(item); if (!r) throw new Error('invalid gateway payload'); return r })
}

describe('historical memory staging report', () => {
  it('shows both actual staging paths through gateway and transcript without exposing IDs or messages', () => {
    for (const payload of producer()) {
      expect(payload['is_error']).toBe(false)
      const result = record(payload['result'])
      expect(result).toMatchObject({ success: true, staged: true, pending_id: '1a2b3c4d' })
      const transcript = new Transcript()
      transcript.toolComplete(stub(payload), 10)
      const c = transcript.call(toolCallId(String(payload['tool_id'])))
      if (!c) throw new Error('missing memory call')
      expect(c.outcome.kind).toBe('done')
      const card = tree(toolNode(c, 0))
      expect(card.p).toMatchObject({ name: 'memory', status: 'done', collapsed: false, meta: ['Staging reported'] })
      expect(reports(card)).toHaveLength(1)
      expect(toolDetail(c, 0).map(tree).flatMap(reports)).toHaveLength(1)
      expect(JSON.stringify(card)).not.toContain('1a2b3c4d')
      expect(JSON.stringify(card)).not.toContain(String(result?.['message']))
      expect(c.result).toBe(payload['result'])
    }
  })

  it('shows a retained replay report without recovering missing results', () => {
    const payload = producer()[0]
    if (!payload) throw new Error('missing payload')
    const args = record(payload['args'])
    if (!args) throw new Error('missing args')
    const replay = (content?: string) => history({ kept: [], id: entryId, messages: [
      { role: 'tool', name: 'memory', tool_call_id: 'memory', args, ...(content ? { content } : {}) }
    ] }).find(e => e.kind === 'turn')?.blocks.find(b => b.kind === 'tool')
    const saved = replay(String(payload['result']))
    const absent = replay()
    if (saved?.kind !== 'tool' || absent?.kind !== 'tool') throw new Error('missing replay calls')
    expect(reports(tree(toolNode(saved.call, 0)))).toHaveLength(1)
    expect(reports(tree(toolNode(absent.call, 0)))).toHaveLength(0)
  })

  it('fails closed on malformed, contradictory, incomplete and inherited signals', () => {
    const good = { success: true, staged: true, pending_id: '1a2b3c4d', message: 'private text' }
    const cases: unknown[] = [undefined, {}, { ...good, success: false }, { ...good, staged: 'true' },
      { ...good, pending_id: 'INVALID!' }, { ...good, pending_id: '' }, { ...good, message: 2 },
      { ...good, proposal_staged: false }, { ...good, error: 'denied' }, { ...good, applied: true },
      Object.assign(Object.create({ staged: true }), { success: true, pending_id: '1a2b3c4d', message: 'private text' })]
    for (const result of cases) {
      const c = make(result)
      expect(memoryStagingReported(c)).toBe(false)
      expect(reports(tree(toolNode(c, 0)))).toHaveLength(0)
    }
    expect(memoryStagingReported(call('other', {}, { result: good }))).toBe(false)
    for (const outcome of [{ kind: 'running' as const }, { kind: 'error' as const, duration: 1 }, { kind: 'cancelled' as const, duration: 1 }]) {
      const c = make(good, { outcome })
      expect(memoryStagingReported(c)).toBe(false)
      expect(reports(tree(toolNode(c, 0)))).toHaveLength(0)
      expect(tree(toolNode(c, 0)).p?.['status']).toBe(outcome.kind)
    }
  })

  it('keeps normal memory content and usage behavior', () => {
    const c = make({ success: true, usage: '12% full' }, { context: 'add: fact' })
    const card = tree(toolNode(c, 0))
    expect(card.p).toMatchObject({ frame: 'inline', meta: ['12% full'], status: 'done', target: 'add: fact' })
    expect(reports(card)).toHaveLength(0)
  })
})
