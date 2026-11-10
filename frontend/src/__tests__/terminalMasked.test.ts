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

const warning = 'Hermes reports that exit 0 may mask a failure in an earlier command.'
const nodes = (node: NodeJson): NodeJson[] => [node, ...(node.c ?? []).flatMap(nodes)]
const notice = (node: NodeJson) => nodes(node).some(n => n.p?.['role'] === 'omp.tool.notice' && JSON.stringify(n.p).includes(warning))
const make = (result: unknown, more: Partial<ToolCall> = {}) => call('terminal', { command: 'npm test | tail -20' }, { result, ...more })

function producer(): Record<string, unknown>[] {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/terminal-masked-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const parsed = parseJson(raw)
  if (!Array.isArray(parsed)) throw new Error('expected producer results')
  return parsed.map(value => {
    const row = record(value)
    if (!row) throw new Error('expected producer result')
    return row
  })
}

describe('masked terminal success advisory', () => {
  it('discloses both exact pinned advisories without changing status, output or recommending action', () => {
    const [pipeline, fallback] = producer()
    for (const result of [pipeline, fallback]) {
      if (!result) throw new Error('missing producer result')
      expect(result).toMatchObject({ exit_code: 0, error: null, output: 'npm ERR! test failed' })
      expect(typeof result['hint']).toBe('string')
      const c = make(result)
      const card = tree(toolNode(c, 5000))
      expect(card.p).toMatchObject({ collapsed: false, exit: 0, meta: ['Exit 0 may mask failure'], status: 'done' })
      expect(notice(card)).toBe(true)
      expect(toolDetail(c, 5000).map(tree).some(notice)).toBe(true)
      expect(nodes(card).find(n => n.k === 'ansi')?.p?.['text']).toBe('npm ERR! test failed')
      expect(JSON.stringify(card)).not.toContain('re-run')
    }
  })

  it('retains both recreation and masked-success notices when the producer reports both', () => {
    const both = producer()[2]
    if (!both) throw new Error('missing combined producer result')
    const card = tree(toolNode(make(both), 5000))
    expect(card.p?.['meta']).toEqual(['Environment recreated; state may be lost', 'Exit 0 may mask failure'])
    expect(notice(card)).toBe(true)
    expect(JSON.stringify(card)).toContain('background processes and unpersisted files may be lost')
  })

  it('carries the producer result through a live transcript completion', () => {
    const event = producer()[5]
    if (!event || typeof event['result'] !== 'string') throw new Error('missing canonical producer envelope')
    const transcript = new Transcript()
    transcript.toolStart({ name: 'terminal', tool_id: 'c1', args: { command: 'npm test | tail' } }, 1)
    transcript.toolComplete(stub<ToolCompletePayload>(event), 2)
    const turn = transcript.entries.find(e => e.kind === 'turn')
    const block = turn?.blocks.find(b => b.kind === 'tool')
    if (block?.kind !== 'tool') throw new Error('missing live terminal call')
    const card = tree(toolNode(block.call, 5000))
    expect(card.p).toMatchObject({ status: 'done', exit: 0 })
    expect(notice(card)).toBe(true)
  })

  it('does not infer a warning from clean, malformed, contradictory, running, cancelled or background calls', () => {
    const [pipeline, , , clean, readonly] = producer()
    if (!pipeline) throw new Error('missing producer result')
    const examples = [
      make(clean), make(readonly), make({ ...pipeline, hint: 'private arbitrary text' }),
      make({ ...pipeline, hint: `${pipeline['hint']} changed` }), make({ ...pipeline, exit_code: 1 }),
      make({ ...pipeline, output: '' }), make({ ...pipeline, error: 'failed' }),
      make(Object.assign(Object.create({ hint: pipeline['hint'] }), { output: 'npm ERR!', exit_code: 0, error: null })),
      make(pipeline, { outcome: { kind: 'running' } }), make(pipeline, { outcome: { kind: 'error', duration: 1 } }),
      make(pipeline, { outcome: { kind: 'cancelled', duration: 1 } }),
      call('terminal', { command: 'npm test | tail', background: true }, { result: pipeline }),
      call('terminal', { command: 'npm test | tail', background: 'true' }, { result: pipeline }),
      call('terminal', { command: 'npm test | tail', background: 1 }, { result: pipeline }),
      make({ ...pipeline, session_id: 'background' }), make({ ...pipeline, session_id: 1 }),
      make({ ...pipeline, status: 'error' }), make({ ...pipeline, success: false }),
      make({ ...pipeline, is_error: true }), make({ ...pipeline, failed: true }), make({ ...pipeline, cancelled: true })
    ]
    for (const c of examples) {
      const card = tree(toolNode(c, 5000))
      expect(notice(card)).toBe(false)
      expect(JSON.stringify(card)).not.toContain('private arbitrary text')
    }
    const validFalse = call('terminal', { command: 'npm test | tail', background: false }, { result: { ...pipeline, session_id: null } })
    expect(notice(tree(toolNode(validFalse, 5000)))).toBe(true)
  })

  it('preserves retained replay and exposes the warning outside the work fold', () => {
    const pipeline = producer()[0]
    let n = 0
    const entries = history({ kept: [], id: p => entryId(`${p}${++n}`), messages: [
      { role: 'user', text: 'run' },
      { role: 'tool', name: 'terminal', tool_call_id: 'term', args: { command: 'npm test | tail' }, content: JSON.stringify(pipeline) },
      { role: 'assistant', text: 'answer' }
    ] })
    const turn = entries.find(e => e.kind === 'turn')
    if (!turn) throw new Error('missing replay turn')
    const block = turn.blocks.find(b => b.kind === 'tool')
    if (block?.kind !== 'tool') throw new Error('missing replay tool')
    expect(notice(tree(toolNode(block.call, 0)))).toBe(true)
    const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }
    const full = tree(entryNode(turn, 'main.masked', cx))
    expect(nodes(full).some(n => n.p?.['role'] === 'hermes.turn.fold' && n.p?.['collapsed'] === true)).toBe(false)
    const card = nodes(full).find(n => n.k === 'tool' && n.p?.['name'] === 'bash')
    expect(card?.p?.['collapsed']).toBe(false)
    if (!card) throw new Error('missing terminal card')
    expect(notice(card)).toBe(true)
  })
})
