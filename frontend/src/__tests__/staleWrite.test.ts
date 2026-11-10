import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { staleWriteRefusal } from '../tools/stale-write.js'
import { writeRefusalNeedsAttention } from '../tools/write-refusal.js'
import { history } from '../transcript/history.js'
import { Transcript } from '../transcript/store.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { actionOf, foldOf, parts, pieces, stepLabel } from '../view/workLogModel.js'
import { parseJson, record } from '../wire/json.js'
import { stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const args = { path: 'x.py', content: 'proposed content' }
const make = (result: unknown, more: Partial<ToolCall> = {}) => call('write_file', args, { result, outcome: { kind: 'error', duration: 1 }, ...more })
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }
const block = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: entryId(id), call: c })
function fixture(): Record<string, unknown> {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/stale-write-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const value = record(parseJson(raw))
  if (!value) throw new Error('missing producer envelope')
  return value
}

describe('stale overwrite refusal', () => {
  it('shows the pinned producer and canonical completion without exposing the backend path', () => {
    const payload = fixture()
    expect(payload['is_error']).toBe(true)
    expect(typeof payload['result']).toBe('string')
    const transcript = new Transcript()
    transcript.toolComplete(stub(payload), 5)
    const live = transcript.call(toolCallId('stale'))
    if (!live) throw new Error('missing call')
    expect(staleWriteRefusal(live)).toBe(true)
    expect(writeRefusalNeedsAttention(live)).toBe(true)
    expect(actionOf(live)).toBe('other')
    expect(stepLabel(live)).toBe('Write refused: x.py')
    const card = tree(toolNode(live, 0))
    expect(card.p).toMatchObject({ status: 'error', collapsed: false })
    const view = JSON.stringify(card)
    expect(view).toContain('This write did not modify the file')
    expect(view).toContain('Candidate content; write refused')
    expect(view).not.toContain('/private/backend')
    for (const hostLocal of [true, false]) {
      const scoped = tree(toolNode(live, 0, undefined, undefined, undefined, { cwd: '/repo', hostLocal, media: true }))
      expect(scoped.p?.['target']).toBe('x.py')
      expect(scoped.p?.['href']).toBeUndefined()
      expect(JSON.stringify(scoped)).not.toContain('/private/backend')
    }
    expect(nodes(card).find(n => n.k === 'code')?.p?.['text']).toBe(args.content)
    expect(JSON.stringify(toolDetail(live, 0).map(tree)).split('Hermes refused this overwrite')).toHaveLength(2)
    const b = block('stale', live)
    const answer: Block = { kind: 'text', id: entryId('answer'), text: 'answer' }
    const turn: TurnEntry = { kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks: [block('before', call('terminal')), b, answer] }
    expect(foldOf(turn)?.hidden.has(b.id)).toBe(false)
    expect(pieces([b])).toEqual([{ kind: 'block', block: b }])
    expect(parts(turn).flatMap(p => p.blocks.map(item => item.id))).toEqual(['before', 'stale', 'answer'])
    expect(JSON.stringify(tree(entryNode(turn, 'main.stale', cx))).split('Hermes refused this overwrite')).toHaveLength(2)
  })

  it('retains the disclosure in history when the producer result survives', () => {
    const payload = fixture()
    let n = 0
    const entries = history({ kept: [], id: p => entryId(`${p}${++n}`), messages: [
      { role: 'tool', name: 'write_file', tool_call_id: 'stale', args, content: String(payload['result']) },
      { role: 'assistant', text: 'answer' }
    ] })
    const turn = entries.find(e => e.kind === 'turn')
    if (!turn || turn.kind !== 'turn') throw new Error('missing history turn')
    const view = JSON.stringify(tree(entryNode(turn, 'main.replay', cx)))
    expect(view).toContain('This write did not modify the file')
    expect(view).toContain('Candidate content; write refused')
    expect(view).not.toContain('/private/backend')
  })

  it('does not infer a refusal from malformed, contradictory, lost or non-error results', () => {
    const result = record(fixture()['result'])
    if (!result || typeof result['error'] !== 'string') throw new Error('missing result')
    for (const r of [
      { ...result, stale_write_blocked: false }, { ...result, path: 'other.py' },
      { ...result, error: 'unrelated' }, { ...result, error: result['error'].replace('synthetic stale reason', '') },
      { ...result, resolved_path: 1 }, { ...result, success: true }, { ...result, bytes_written: 1 },
      { ...result, diff: 'diff' }, { ...result, lint: {} }, { ...result, truncated: true }, {},
      Object.assign(Object.create({ stale_write_blocked: true }), { path: args.path, error: result['error'] })
    ]) expect(staleWriteRefusal(make(r))).toBe(false)
    const contradictory = make({ ...result, success: true })
    expect(actionOf(contradictory)).toBe('other')
    expect(stepLabel(contradictory)).toBe('Write failed')
    expect(JSON.stringify(tree(toolNode(contradictory, 0)))).not.toContain('This write did not modify the file')
    for (const hostLocal of [true, false]) {
      const card = tree(toolNode(contradictory, 0, undefined, undefined, undefined, { cwd: '/repo', hostLocal, media: true }))
      expect(card.p?.['target']).toBe('x.py')
      expect(card.p?.['href']).toBeUndefined()
      expect(JSON.stringify(card)).not.toContain('/private/backend')
    }
    for (const outcome of [{ kind: 'done' as const, duration: 1 }, { kind: 'cancelled' as const, duration: 1 }, { kind: 'running' as const }]) {
      expect(staleWriteRefusal(make(result, { outcome }))).toBe(false)
    }
    expect(staleWriteRefusal(call('patch', args, { result, outcome: { kind: 'error', duration: 1 } }))).toBe(false)
    expect(staleWriteRefusal(call('write_file', { path: args.path }, { result, outcome: { kind: 'error', duration: 1 } }))).toBe(false)
  })

  it('suppresses a stale outer diff on the validated refusal while preserving the candidate', () => {
    const result = record(fixture()['result'])
    const c = make(result, { diff: '@@ -0,0 +1 @@\n+candidate' })
    const card = tree(toolNode(c, 0))
    expect(staleWriteRefusal(c)).toBe(true)
    expect(nodes(card).some(n => n.k === 'diff')).toBe(false)
    expect(JSON.stringify(card)).not.toContain('new file')
    expect(JSON.stringify(card)).toContain('Candidate content; write refused')
  })

  it('never renders the arbitrary producer reason', () => {
    const result = record(fixture()['result'])
    if (!result || typeof result['error'] !== 'string') throw new Error('missing result')
    const error = result['error'].replace('synthetic stale reason', 'SECRET\u001b\u202e' + 'x'.repeat(5000))
    const c = make({ ...result, error })
    expect(staleWriteRefusal(c)).toBe(true)
    const view = JSON.stringify(tree(toolNode(c, 0)))
    expect(view).toContain('This write did not modify the file')
    expect(view).not.toContain('SECRET')
    expect(view).not.toContain('/private/backend')
  })
})
