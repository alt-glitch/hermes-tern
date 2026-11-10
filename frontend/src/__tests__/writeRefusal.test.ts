import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { ToolCall } from '../model.js'
import { writeRefusalNeedsAttention } from '../tools/write-refusal.js'
import { history } from '../transcript/history.js'
import { Transcript } from '../transcript/store.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { stepLabel } from '../view/workLogModel.js'
import { parseJson, record } from '../wire/json.js'
import { stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const errors = (roots: NodeJson[]) => roots.flatMap(nodes).filter(n => n.p?.['role'] === 'omp.tool.error')
const args = { path: 'x.json', content: '{bad json' }
const make = (result: unknown, more: Partial<ToolCall> = {}) => call('write_file', args, { result, outcome: { duration: 1, kind: 'error' }, ...more })
function fixture(): Record<string, unknown> {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/write-refusal-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const result = record(parseJson(raw))
  if (!result) throw new Error('missing envelope')
  return result
}

describe('fail-closed write refusal', () => {
  it('shows actual pinned refusal beside explicitly labeled candidate in card, detail and replay', () => {
    const payload = fixture()
    expect(payload['is_error']).toBe(true)
    const result = record(payload['result'])
    if (!result || typeof result['error'] !== 'string') throw new Error('missing refusal')
    expect(result).toMatchObject({ bytes_written: 0, dirs_created: false })
    expect(result['error']).toContain('NOT created or modified')
    const transcript = new Transcript()
    transcript.toolComplete(stub(payload), 5)
    const live = transcript.call(toolCallId('write'))
    if (!live) throw new Error('missing live call')
    expect(live.outcome.kind).toBe('error')
    expect(writeRefusalNeedsAttention(live)).toBe(true)
    expect(stepLabel(live)).toBe('Write refused: x.json')
    const card = tree(toolNode(live, 0))
    expect(card.p).toMatchObject({ status: 'error', collapsed: false, meta: ['1 line', 'Write refused'] })
    expect(errors([card]).map(n => n.p?.['spans'])).toEqual([[{ s: 'error', t: result['error'] }]])
    expect(errors(toolDetail(live, 0).map(tree))).toHaveLength(1)
    expect(JSON.stringify(card)).toContain('Candidate content; write refused')
    expect(nodes(card).find(n => n.k === 'code')?.p?.['text']).toBe('{bad json')
    let n = 0
    const replayArgs = record(payload['args'])
    if (!replayArgs) throw new Error('missing args')
    const entries = history({ kept: [], id: p => entryId(`${p}${++n}`), messages: [
      { role: 'tool', name: 'write_file', tool_call_id: 'replay', args: replayArgs, content: String(payload['result']) }
    ] })
    const turn = entries.find(e => e.kind === 'turn')
    const block = turn?.blocks.find(b => b.kind === 'tool')
    if (block?.kind !== 'tool') throw new Error('missing replay')
    expect(errors([tree(toolNode(block.call, 0))])).toHaveLength(1)
  })

  it('does not promote malformed or contradictory envelopes or other outcomes', () => {
    const result = record(fixture()['result'])
    if (!result) throw new Error('missing result')
    for (const value of [
      { ...result, bytes_written: 1 }, { ...result, dirs_created: true }, { ...result, verified: true },
      { ...result, files_modified: ['x.json'] }, { ...result, diff: 'diff' }, { ...result, success: true },
      { ...result, error: 'arbitrary' }, { ...result, error: null }, { ...result, error: undefined },
      Object.assign(Object.create({ error: result['error'] }), { bytes_written: 0, dirs_created: false })
    ]) expect(writeRefusalNeedsAttention(make(value))).toBe(false)
    for (const outcome of [{ kind: 'done' as const, duration: 1 }, { kind: 'cancelled' as const, duration: 1 }, { kind: 'running' as const }]) {
      expect(writeRefusalNeedsAttention(make(result, { outcome }))).toBe(false)
    }
    expect(writeRefusalNeedsAttention(call('write_file', { path: 'x.json' }, { result, outcome: { kind: 'error', duration: 1 } }))).toBe(false)
  })

  it('suppresses a synthetic stale gateway diff and bounds and escapes the retained error', () => {
    const result = record(fixture()['result'])
    if (!result || typeof result['error'] !== 'string') throw new Error('missing result')
    const c = make(result, { diff: '@@ -0,0 +1 @@\n+candidate' })
    const card = tree(toolNode(c, 0))
    expect(writeRefusalNeedsAttention(c)).toBe(true)
    expect(nodes(card).some(n => n.k === 'diff')).toBe(false)
    expect(JSON.stringify(card)).not.toContain('new file')
    expect(JSON.stringify(card)).toContain('Candidate content; write refused')
    const long = result['error'].replace('JSONDecodeError:', 'JSONDecodeError:' + 'x'.repeat(2000) + '😀')
    expect(JSON.stringify(tree(toolNode(make({ ...result, error: long }), 0)))).toContain('Write error clipped in view')
    const unsafe = result['error'].replace('JSONDecodeError:', 'JSONDecodeError:\u001b\u202e')
    const unsafeCard = tree(toolNode(make({ ...result, error: unsafe }), 0))
    expect(JSON.stringify(errors([unsafeCard]))).toContain('\\\\u001b')
    expect(JSON.stringify(unsafeCard)).toContain('Write error control characters escaped in view')
  })
})
