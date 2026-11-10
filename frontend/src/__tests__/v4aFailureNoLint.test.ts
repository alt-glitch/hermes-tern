import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { v4aLintNeedsAttention } from '../tools/v4a-lint.js'
import { history } from '../transcript/history.js'
import { Transcript } from '../transcript/store.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { parts } from '../view/workLogModel.js'
import { parseJson, record } from '../wire/json.js'
import { stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const prefix = 'Apply phase failed (state may be inconsistent — run `git diff` to assess):\n'
const error = `${prefix}  • Failed to update y.py: write refused`
const args = { mode: 'patch', patch: '*** Begin Patch\n*** End Patch' }
const make = (result: unknown, more: Partial<ToolCall> = {}) => call('patch', args, { result, outcome: { kind: 'error', duration: 1 }, ...more })
const tool = (id: string, c: ToolCall): Block => ({ kind: 'tool', id: entryId(id), call: c })
const turn = (blocks: Block[]): TurnEntry => ({ kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks })
const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const errorNodes = (roots: NodeJson[]) => roots.flatMap(nodes).filter(n => n.p?.['role'] === 'omp.tool.error')

function fixtures(): Record<string, unknown>[] {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/v4a-failure-no-lint.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const data = parseJson(raw)
  if (!Array.isArray(data)) throw new Error('expected payloads')
  return data.map(item => { const r = record(item); if (!r) throw new Error('bad payload'); return r })
}

describe('V4A apply failures without retained lint errors', () => {
  it('shows actual pinned failed diff and gateway error once for absent and clean lint', () => {
    for (const [i, payload] of fixtures().entries()) {
      const result = record(payload['result'])
      expect(payload['is_error']).toBe(true)
      expect(result).toMatchObject({ success: false, error })
      expect(result?.['diff']).toContain('+x = 42')
      if (i === 0) expect(result?.['lint']).toBeUndefined()
      else expect(result?.['lint']).toEqual({ 'x.py': { status: 'ok', output: '' } })
      const transcript = new Transcript()
      transcript.toolComplete(stub(payload), 5)
      const c = transcript.call(toolCallId(String(payload['tool_id'])))
      if (!c) throw new Error('missing tool')
      expect(c.outcome.kind).toBe('error')
      expect(v4aLintNeedsAttention(c)).toBe(true)
      const t = turn([tool('before', call('terminal')), tool('patch', c), tool('after', call('terminal')), { kind: 'text', id: entryId('answer'), text: 'answer' }])
      expect(parts(t).map(p => p.kind)).toEqual(['fold', 'shown', 'fold', 'shown'])
      const card = nodes(tree(entryNode(t, 'main.test', cx))).find(n => n.k === 'tool' && n.p?.['name'] === 'edit')
      if (!card) throw new Error('missing direct card')
      expect(card.p).toMatchObject({ status: 'error', collapsed: false })
      expect(errorNodes([card]).map(n => n.p?.['spans'])).toEqual([[{ s: 'error', t: error }]])
      expect(nodes(card).find(n => n.k === 'diff')?.p?.['text']).toContain('+x = 42')
      expect(errorNodes(toolDetail(c, 0).map(tree)).map(n => n.p?.['spans'])).toEqual([[{ s: 'error', t: error }]])
      expect(JSON.stringify(card)).not.toContain('Lint reported an error')
      const replayArgs = record(payload['args'])
      if (!replayArgs) throw new Error('missing replay args')
      let n = 0
      const replay = history({ kept: [], id: p => entryId(`${p}${++n}`), messages: [
        { role: 'tool', name: 'patch', tool_call_id: 'replay', args: replayArgs, content: String(payload['result']) },
        { role: 'assistant', text: 'answer' }
      ] })
      const item = replay.find(e => e.kind === 'turn')
      if (!item) throw new Error('missing replay')
      const replayNodes = nodes(tree(entryNode(item, 'main.replay', cx)))
      expect(replayNodes.filter(n => n.p?.['role'] === 'omp.tool.error')).toHaveLength(1)
    }
  })

  it('shows the failure once with no diff and with malformed lint, without fabricating lint', () => {
    for (const lint of [undefined, null, 'bad', [], 3, { 'x.py': { status: 'error', output: 1 } }]) {
      const c = make({ success: false, error, lint })
      const card = tree(toolNode(c, 0))
      expect(errorNodes([card]).map(n => n.p?.['spans'])).toEqual([[{ s: 'error', t: error }]])
      expect(errorNodes(toolDetail(c, 0).map(tree))).toHaveLength(1)
      expect(nodes(card).some(n => n.k === 'diff' || n.p?.['role'] === 'omp.tool.lint')).toBe(false)
    }
  })

  it('requires the pinned apply failure and failed outcome; preserves sanitization limits', () => {
    for (const result of [{ success: true, error }, { success: false, error: prefix }, { success: false, error: 'other error' },
      { success: false, error, no_change: true }, { success: false, error, partial: true },
      Object.assign(Object.create({ error }), { success: false })]) {
      expect(v4aLintNeedsAttention(make(result))).toBe(false)
    }
    for (const outcome of [{ kind: 'done' as const, duration: 1 }, { kind: 'cancelled' as const, duration: 1 }, { kind: 'running' as const }]) {
      expect(v4aLintNeedsAttention(make({ success: false, error }, { outcome }))).toBe(false)
    }
    const unsafe = tree(toolNode(make({ success: false, error: prefix + 'x'.repeat(1999) + '😀\u001b' }), 0))
    expect(errorNodes([unsafe])).toHaveLength(1)
    expect(JSON.stringify(unsafe)).toContain('Patch error clipped in view')
    expect(JSON.stringify(unsafe)).not.toContain('😀')
    const escaped = tree(toolNode(make({ success: false, error: prefix + 'bad\u001b\u202e' }), 0))
    expect(JSON.stringify(errorNodes([escaped]))).toContain('\\\\u001b')
    expect(JSON.stringify(escaped)).toContain('Patch error control characters escaped in view')
  })
})
