import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { writeRefusalNeedsAttention } from '../tools/write-refusal.js'
import { history } from '../transcript/history.js'
import { Transcript } from '../transcript/store.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { foldOf, parts, pieces } from '../view/workLogModel.js'
import { parseJson, record } from '../wire/json.js'
import { stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const tool = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: entryId(id), call: c })
const text = (id: string): Block => ({ kind: 'text', id: entryId(id), text: id })
const turn = (blocks: Block[]): TurnEntry => ({ kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks })
const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]

function payload(): Record<string, unknown> {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/write-refusal-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const value = record(parseJson(raw))
  if (!value) throw new Error('missing producer envelope')
  return value
}

describe('write refusal visibility in work', () => {
  it('keeps the actual pinned producer refusal visible once, in order and with error status', () => {
    const p = payload()
    const transcript = new Transcript()
    transcript.toolComplete(stub(p), 5)
    const c = transcript.call(toolCallId('write'))
    if (!c) throw new Error('missing live write')
    const b = tool('write', c)
    const t = turn([tool('before', call('terminal')), b, tool('after', call('terminal')), text('answer')])
    expect(writeRefusalNeedsAttention(c)).toBe(true)
    expect(foldOf(t)?.hidden.has(b.id)).toBe(false)
    expect(parts(t).map(part => `${part.kind}:${part.blocks.map(item => item.id).join(',')}`))
      .toEqual(['fold:before', 'shown:write', 'fold:after', 'shown:answer'])
    expect(pieces([b], t.blocks)).toEqual([{ kind: 'block', block: b }])
    const root = tree(entryNode(t, 'main.refusal', cx))
    const card = nodes(root).find(n => n.k === 'tool' && n.p?.['name'] === 'write')
    expect(card?.p).toMatchObject({ status: 'error', collapsed: false })
    const data = JSON.stringify(card)
    expect(data.split('NOT created or modified')).toHaveLength(2)
    expect(data).toContain('Candidate content; write refused')
    expect(nodes(card ?? root).find(n => n.k === 'code')?.p?.['text']).toBe('{bad json')
  })

  it('retains other attention cards and does not promote malformed or non-error refusals', () => {
    const p = payload()
    const result = record(p['result'])
    const args = record(p['args'])
    if (!result || !args) throw new Error('missing refusal')
    const refusal = tool('write', call('write_file', args, { result, outcome: { kind: 'error', duration: 1 } }))
    const web = tool('web', call('web_extract', {}, { result: { results: [{ error: 'failed' }] } }))
    const delegate = tool('delegate', call('delegate_task', {}, { result: { results: [{ status: 'completed', exit_reason: 'max_iterations', truncated: true, summary: 'partial' }] } }))
    const evaluation = tool('eval', call('execute_code', {}, { result: { stdout_truncated: true, output: 'partial' } }))
    const lint = tool('lint', call('write_file', { path: 'x.py', content: 'bad' }, { result: { lint: { status: 'error', output: 'syntax error' } } }))
    const t = turn([web, delegate, evaluation, lint, refusal, text('answer')])
    expect(parts(t).flatMap(part => part.blocks.map(item => item.id))).toEqual(['web', 'delegate', 'eval', 'lint', 'write', 'answer'])
    const rendered = JSON.stringify(tree(entryNode(t, 'main.combined', cx)))
    expect(rendered).toContain('At least one delegated task reached its iteration limit')
    expect(rendered).toContain('Hermes reports stdout was truncated')
    expect(rendered).toContain('Lint reported an error')
    expect(rendered).toContain('NOT created or modified')
    for (const outcome of [{ kind: 'done' as const, duration: 1 }, { kind: 'cancelled' as const, duration: 1 }, { kind: 'running' as const }]) {
      expect(writeRefusalNeedsAttention(call('write_file', args, { result, outcome }))).toBe(false)
    }
    const bad = tool('bad', call('write_file', args, { result: { ...result, bytes_written: 1 }, outcome: { kind: 'error', duration: 1 } }))
    expect(pieces([bad])).toEqual([{ kind: 'work', items: [bad] }])
  })

  it('shows retained replay only when the refusal survived', () => {
    const p = payload()
    const args = record(p['args'])
    if (!args) throw new Error('missing args')
    let n = 0
    const replay = (content?: string) => history({ kept: [], id: prefix => entryId(`${prefix}${++n}`), messages: [
      { role: 'tool', name: 'write_file', tool_call_id: 'write', args, ...(content ? { content } : {}) },
      { role: 'assistant', text: 'answer' }
    ] }).find(e => e.kind === 'turn')
    const kept = replay(String(p['result']))
    const lost = replay()
    if (!kept || kept.kind !== 'turn' || !lost || lost.kind !== 'turn') throw new Error('missing replay')
    expect(JSON.stringify(tree(entryNode(kept, 'main.kept', cx)))).toContain('NOT created or modified')
    expect(JSON.stringify(tree(entryNode(lost, 'main.lost', cx)))).not.toContain('NOT created or modified')
  })
})
