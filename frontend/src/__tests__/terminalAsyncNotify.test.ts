import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { ToolCompletePayload } from '@hermes/shared/gateway-events'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId } from '../core/ids.js'
import type { ToolCall } from '../model.js'
import { history } from '../transcript/history.js'
import { Transcript } from '../transcript/store.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { parseJson, record } from '../wire/json.js'
import { stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const message = 'Hermes reported that async process notifications were unavailable for this session.'
const nodes = (node: NodeJson): NodeJson[] => [node, ...(node.c ?? []).flatMap(nodes)]
const notice = (node: NodeJson) => nodes(node).some(n => n.p?.['role'] === 'omp.tool.notice' && JSON.stringify(n.p).includes(message))
const make = (result: unknown, more: Partial<ToolCall> = {}) => call('terminal', { command: 'make test', background: true, notify_on_complete: true }, { result, ...more })

function producer(): { args: Record<string, unknown>; result: Record<string, unknown>; event: Record<string, unknown> }[] {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/terminal-async-notify-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const events = parseJson(raw)
  if (!Array.isArray(events)) throw new Error('expected envelopes')
  return events.map(value => {
    const event = record(value)
    const args = record(event?.['args'])
    const result = typeof event?.['result'] === 'string' ? record(parseJson(event['result'])) : undefined
    if (!event || !args || !result) throw new Error('invalid envelope')
    return { event, args, result }
  })
}

describe('unavailable terminal async notifications', () => {
  it('discloses the actual pinned producer report for completion and pattern requests', () => {
    for (const row of producer()) {
      const c = call('terminal', row.args, { result: row.result })
      const card = tree(toolNode(c, 5000))
      expect(card.p).toMatchObject({ status: 'done', collapsed: false })
      expect(notice(card)).toBe(true)
      expect(toolDetail(c, 5000).map(tree).some(notice)).toBe(true)
      expect(JSON.stringify(card)).not.toContain('notify_on_complete / watch_patterns are not available')
      expect(JSON.stringify(card)).not.toContain('notify on exit')
    }
  })

  it('retains the producer report across live completion and replay without folding the card', () => {
    const row = producer()[0]
    if (!row) throw new Error('missing producer event')
    const transcript = new Transcript()
    transcript.toolStart({ name: 'terminal', tool_id: 'c1', args: row.args }, 1)
    transcript.toolComplete(stub<ToolCompletePayload>(row.event), 2)
    const turn = transcript.entries.find(e => e.kind === 'turn')
    const block = turn?.blocks.find(b => b.kind === 'tool')
    if (block?.kind !== 'tool') throw new Error('missing live terminal call')
    expect(notice(tree(toolNode(block.call, 5000)))).toBe(true)

    let n = 0
    const entries = history({ kept: [], id: p => entryId(`${p}${++n}`), messages: [
      { role: 'user', text: 'run' },
      { role: 'tool', name: 'terminal', tool_call_id: 'term', args: row.args, content: JSON.stringify(row.result) },
      { role: 'assistant', text: 'answer' }
    ] })
    const replay = entries.find(e => e.kind === 'turn')
    if (!replay) throw new Error('missing replay turn')
    const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }
    const full = tree(entryNode(replay, 'main.notify', cx))
    const card = nodes(full).find(n => n.k === 'tool' && n.p?.['name'] === 'bash')
    if (!card) throw new Error('missing terminal card')
    expect(card.p?.['collapsed']).toBe(false)
    expect(notice(card)).toBe(true)
  })

  it('does not infer a limitation from missing, malformed, contradictory or unsettled reports', () => {
    const row = producer()[0]
    if (!row) throw new Error('missing producer event')
    const result = row.result
    const cases = [
      make({ ...result, notify_unsupported: 'private arbitrary text' }),
      make({ ...result, notify_unsupported: `${result['notify_unsupported']} changed` }),
      make({ ...result, notify_on_complete: true }), make({ ...result, session_id: '' }),
      make({ ...result, session_id: 42 }), make({ ...result, output: '' }),
      make({ ...result, exit_code: 1 }), make({ ...result, error: 'failed' }),
      make({ ...result, watch_patterns: ['READY'] }), make({ ...result, heartbeat_seconds: 60 }),
      make(Object.assign(Object.create({ notify_unsupported: result['notify_unsupported'] }), { ...result, notify_unsupported: undefined })),
      make(result, { outcome: { kind: 'running' } }), make(result, { outcome: { kind: 'error', duration: 1 } }),
      make(result, { outcome: { kind: 'cancelled', duration: 1 } })
    ]
    for (const c of cases) {
      const card = tree(toolNode(c, 5000))
      expect(notice(card)).toBe(false)
      expect(JSON.stringify(card)).not.toContain('private arbitrary text')
    }
  })
})
