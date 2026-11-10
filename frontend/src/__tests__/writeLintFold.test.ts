import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { writeLintNeedsAttention } from '../tools/write-lint-attention.js'
import { history } from '../transcript/history.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { foldOf, parts, pieces } from '../view/workLogModel.js'
import { record } from '../wire/json.js'
import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const notice = 'Lint reported an error'
const source = 'def broken(:\n    pass\n'
const write = (result: unknown, more: Partial<ToolCall> = {}) => call('write_file', { path: 'x.py', content: source }, { result, ...more })
const tool = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: entryId(id), call: c })
const text = (id: string): Block => ({ kind: 'text', id: entryId(id), text: id })
const turn = (blocks: Block[]): TurnEntry => ({ kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks })
const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]

/** Actual pinned syntax lint and write-result serializer; no disk write or provider. */
function producerResult(): Record<string, unknown> {
  const script = `from tools.file_operations_lint import LintMixin
from tools.file_operations_common import WriteResult
import json
lint = LintMixin()._check_lint_delta('x.py','x = 1\\n','def broken(:\\n    pass\\n').to_dict()
print(json.dumps(WriteResult(bytes_written=23,verified=True,lint=lint).to_dict()))`
  const result = record(execFileSync('python3', ['-c', script], { cwd: resolve('.hermes-src'), encoding: 'utf8' }))
  if (!result) throw new Error('missing producer output')
  return result
}

describe('write-file lint attention in work folds', () => {
  it('keeps the pinned producer disclosure visible in order and retains the successful write', () => {
    const result = producerResult()
    const b = tool('write', write(result))
    const t = turn([tool('before', call('terminal')), b, tool('after', call('terminal')), text('answer')])
    expect(writeLintNeedsAttention(b.call)).toBe(true)
    expect(foldOf(t)?.hidden.has(b.id)).toBe(false)
    expect(parts(t).map(p => `${p.kind}:${p.blocks.map(item => item.id).join(',')}`))
      .toEqual(['fold:before', 'shown:write', 'fold:after', 'shown:answer'])
    expect(pieces([b], t.blocks)).toEqual([{ kind: 'block', block: b }])
    const root = tree(entryNode(t, 'main.write-lint', cx))
    const card = nodes(root).find(node => node.k === 'tool' && node.p?.['name'] === 'write')
    expect(card?.p).toMatchObject({ status: 'done', collapsed: false })
    expect(JSON.stringify(card)).toContain(notice)
    expect(JSON.stringify(card)).toContain('SyntaxError')
    expect(nodes(card ?? root).find(node => node.k === 'code')?.p?.['text']).toBe(source.trimEnd())
    expect(b.call.result).toBe(result)
    expect(b.call.outcome.kind).toBe('done')
  })

  it('keeps prior web, delegate and eval warnings visible in order', () => {
    const web = tool('web', call('web_extract', {}, { result: { results: [{ error: 'failed' }] } }))
    const delegate = tool('delegate', call('delegate_task', {}, { result: { results: [{ status: 'completed', exit_reason: 'max_iterations', truncated: true, summary: 'partial' }] } }))
    const evalBlock = tool('eval', call('execute_code', {}, { result: { stdout_truncated: true, output: 'partial' } }))
    const b = tool('write', write(producerResult()))
    const t = turn([tool('before', call('terminal')), web, delegate, evalBlock, b, text('answer')])
    expect(parts(t).flatMap(p => p.blocks.map(item => item.id))).toEqual(['before', 'web', 'delegate', 'eval', 'write', 'answer'])
    expect([web, delegate, evalBlock, b].map(item => foldOf(t)?.hidden.has(item.id))).toEqual([false, false, false, false])
    const data = JSON.stringify(tree(entryNode(t, 'main.combined', cx)))
    // #135's base carries web attention; its visual error card is merged on nightly.
    expect(data).toContain('"name":"fetch"')
    expect(data).toContain('At least one delegated task reached its iteration limit')
    expect(data).toContain('Hermes reports stdout was truncated')
    expect(data).toContain(notice)
  })

  it('leaves missing, malformed and non-error lint and unrelated patch work folded', () => {
    const cases: unknown[] = [undefined, {}, { lint: null }, { lint: { status: 'ok', output: '' } },
      { lint: { status: 'skipped', message: 'unavailable' } }, { lint: { status: 'error' } },
      { lint: { status: 'error', output: 4 } }, { lint: { status: 'error', output: 'x', message: 7 } }]
    for (const result of cases) {
      const b = tool('write', write(result))
      expect(writeLintNeedsAttention(b.call)).toBe(false)
      expect(foldOf(turn([b, text('answer')]))?.hidden.has(b.id)).toBe(true)
    }
    expect(writeLintNeedsAttention(call('patch', {}, { result: { lint: { status: 'error', output: 'x' } } }))).toBe(false)
  })

  it('fails closed when a malformed retained result throws during parsing', () => {
    const bad: Record<string, unknown> = {}
    Object.defineProperty(bad, 'lint', { enumerable: true, get: () => { throw new Error('malformed lint') } })
    const b = tool('write', write(bad, { resultText: 'safe retained result' }))
    const t = turn([tool('before', call('terminal')), b, text('answer')])
    expect(writeLintNeedsAttention(b.call)).toBe(false)
    expect(foldOf(t)?.hidden.has(b.id)).toBe(true)
    expect(() => tree(entryNode(t, 'main.malformed', cx))).not.toThrow()
    const args: Record<string, unknown> = { path: 'x.py' }
    Object.defineProperty(args, 'content', { enumerable: true, get: () => { throw new Error('malformed content') } })
    const badArgs = call('write_file', args, { result: { lint: { status: 'error', output: 'x' } } })
    expect(writeLintNeedsAttention(badArgs)).toBe(false)
    const badArgsBlock = tool('write-args', badArgs)
    const combined = turn([tool('sibling', call('terminal', { command: 'echo sibling' })), badArgsBlock, text('answer')])
    expect(foldOf(combined)?.hidden.has(badArgsBlock.id)).toBe(true)
  })

  it('preserves error, cancellation and running outcomes without inventing lint', () => {
    const result = producerResult()
    for (const outcome of [{ kind: 'error' as const, duration: 1 }, { kind: 'cancelled' as const, duration: 1 }]) {
      const b = tool('write', write(result, { outcome }))
      const t = turn([tool('before', call('terminal')), b, text('answer')])
      expect(writeLintNeedsAttention(b.call)).toBe(true)
      expect(foldOf(t)?.hidden.has(b.id)).toBe(false)
      const card = nodes(tree(entryNode(t, 'main.settled', cx))).find(node => node.k === 'tool' && node.p?.['name'] === 'write')
      expect(card?.p).toMatchObject({ status: outcome.kind, collapsed: false })
      expect(JSON.stringify(card)).toContain(notice)
      expect(b.call.outcome).toEqual(outcome)
    }
    const running = tool('running', write(result, { outcome: { kind: 'running' } }))
    expect(writeLintNeedsAttention(running.call)).toBe(false)
    expect(foldOf(turn([running, text('answer')]))?.hidden.has(running.id)).not.toBe(true)
    expect(JSON.stringify(tree(entryNode(turn([running, text('answer')]), 'main.running', cx)))).not.toContain(notice)
  })

  it('shows the retained replay result only when the lint result was retained', () => {
    const replay = (content?: string) => history({ kept: [], id: entryId, messages: [
      { role: 'tool', name: 'write_file', tool_call_id: 'write', args: { path: 'x.py', content: source }, ...(content ? { content } : {}) },
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
