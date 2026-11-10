import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { ToolCall } from '../model.js'
import { detailOf } from '../tools/detail.js'
import { patchNoWriteReported } from '../tools/patch-noop.js'
import { v4aLintNeedsAttention } from '../tools/v4a-lint.js'
import { history } from '../transcript/history.js'
import { Transcript } from '../transcript/store.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { parseJson, record } from '../wire/json.js'
import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const args = { mode: 'patch', patch: '*** Begin Patch\n*** End Patch' }
const report = { status: 'error', output: 'syntax problem' }
const nodes = (n: NodeJson): NodeJson[] => [n, ...(n.c ?? []).flatMap(nodes)]
const patch = (result: unknown, more: Partial<ToolCall> = {}) => call('patch', args, { result, ...more })
const plain = (c: ToolCall) => JSON.stringify(tree(toolNode(c, 0)))

function produced(): Record<string, unknown>[] {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/v4a-lint-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const data = parseJson(raw)
  if (!Array.isArray(data)) throw new Error('expected producer results')
  return data.map(item => { const r = record(item); if (!r) throw new Error('bad producer result'); return r })
}

describe('successful V4A retained lint', () => {
  it('shows the actual retained error and path while preserving the successful diff and outcome', () => {
    const [result] = produced()
    expect(result).toMatchObject({ success: true, lint: { 'x.py': { status: 'error', output: expect.stringContaining('SyntaxError') }, 'y.py': { status: 'ok' } } })
    const c = patch(result)
    const card = tree(toolNode(c, 0))
    expect(card.p).toMatchObject({ name: 'edit', status: 'done', collapsed: false })
    expect(JSON.stringify(card)).toContain('Lint reported an error for x.py')
    expect(JSON.stringify(card)).not.toContain('Lint reported an error for y.py')
    expect(JSON.stringify(toolDetail(c, 0).map(tree))).toContain('SyntaxError')
    expect(nodes(card).find(n => n.k === 'diff')?.p?.['text']).toContain('def broken(:')
    expect(nodes(card).every(n => n.p?.['href'] === undefined)).toBe(true)
    expect(c.result).toBe(result)
    expect(c.outcome.kind).toBe('done')
  })

  it('uses only the producer map when repeated paths overwrite or keep prior lint', () => {
    const [, , overwritten, retained] = produced()
    expect(overwritten).toMatchObject({ success: true, lint: { 'x.py': { status: 'ok' } } })
    expect(plain(patch(overwritten))).not.toContain('Lint reported an error')
    expect(retained).toMatchObject({ success: true, lint: { 'x.py': { status: 'error' } } })
    expect(plain(patch(retained))).toContain('Lint reported an error for x.py')
  })

  it('retains live and history results without guessing missing args or results', () => {
    const [result] = produced()
    const store = new Transcript()
    store.toolComplete({ tool_id: 'live', name: 'patch', args, result }, 10)
    const live = store.call(toolCallId('live'))
    if (!live) throw new Error('missing live patch')
    expect(plain(live)).toContain('Lint reported an error for x.py')
    const replay = (content?: string) => history({ kept: [], id: entryId, messages: [
      { role: 'tool', name: 'patch', tool_call_id: 'saved', args, ...(content ? { content } : {}) }
    ] }).find(e => e.kind === 'turn')
    const saved = replay(JSON.stringify(result))?.blocks.find(b => b.kind === 'tool')
    const missing = replay()?.blocks.find(b => b.kind === 'tool')
    if (saved?.kind !== 'tool' || missing?.kind !== 'tool') throw new Error('missing replay patch')
    expect(plain(saved.call)).toContain('Lint reported an error for x.py')
    expect(plain(missing.call)).not.toContain('Lint reported an error')
  })

  it('renders own prototype-named keys as inert labels and ignores empty/inherited paths', () => {
    const entries = Object.fromEntries(['__proto__', 'constructor', 'toString', 'status', 'output', '/remote/x.py'].map(p => [p, report]))
    const c = patch({ success: true, lint: entries })
    const card = tree(toolNode(c, 0))
    const text = JSON.stringify(card)
    for (const path of Object.keys(entries)) expect(text).toContain(`Lint reported an error for ${path}`)
    expect(nodes(card).every(n => n.p?.['href'] === undefined)).toBe(true)
    expect(plain(patch({ success: true, lint: { '': report } }))).not.toContain('Lint reported an error')
    const inherited = Object.create({ 'other.py': report })
    expect(plain(patch({ success: true, lint: inherited }))).not.toContain('Lint reported an error')
  })

  it('discloses uninspected entries neutrally even when no inspected error exists', () => {
    const lint = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`file${i}.py`, i === 8 ? report : { status: 'ok', output: '' }]))
    const c = patch({ success: true, lint })
    const card = tree(toolNode(c, 0))
    expect(v4aLintNeedsAttention(c)).toBe(true)
    expect(JSON.stringify(card)).toContain('Additional lint entries were not inspected')
    expect(JSON.stringify(card)).not.toContain('Lint reported an error')
    expect(card.p?.['collapsed']).toBe(false)
  })

  it('escapes and clips paths and reports without links or split surrogate pairs', () => {
    const path = 'p\n\t\u001b\u2028\u206a\ud800' + 'x'.repeat(300)
    const c = patch({ success: true, lint: { [path]: { status: 'error', output: 'z'.repeat(999) + '😀!' } } })
    const card = tree(toolNode(c, 0))
    const text = JSON.stringify(card)
    expect(text).toContain('Lint report clipped in view')
    expect(text).toContain('Lint report control characters escaped in view')
    expect(text).toContain('\\\\u000a\\\\u0009\\\\u001b\\\\u2028\\\\u206a\\\\ud800')
    expect(text).not.toContain('😀')
    expect(nodes(card).every(n => n.p?.['href'] === undefined)).toBe(true)
  })

  it('excludes partial and contradictory results, malformed entries, other modes and running calls', () => {
    const [, partial] = produced()
    expect(partial).toMatchObject({ success: false, error: expect.stringContaining('Apply phase failed'), lint: { 'x.py': { status: 'error' } } })
    expect(v4aLintNeedsAttention(patch(partial))).toBe(false)
    const good = { success: true, lint: { 'x.py': report } }
    for (const bad of [{ ...good, success: false }, { ...good, no_change: true }, { ...good, error: 'failed' },
      { ...good, partial: true }, { ...good, truncated: true }, { ...good, failed: true }, { ...good, exit_code: 1 },
      { success: true, lint: { 'x.py': { status: 'error', output: 4 } } }, { success: true, lint: [] }]) {
      expect(v4aLintNeedsAttention(patch(bad))).toBe(false)
    }
    for (const badArgs of [{}, { mode: 'replace', patch: args.patch }, { mode: 'patch' }, { mode: 'patch', patch: '' }]) {
      expect(v4aLintNeedsAttention(call('patch', badArgs, { result: good }))).toBe(false)
    }
    const noWrite = call('patch', { path: 'x.py' }, { result: { success: true, no_change: true } })
    expect(patchNoWriteReported(noWrite)).toBe(true)
    expect(v4aLintNeedsAttention(patch(good, { outcome: { kind: 'running' } }))).toBe(false)
    for (const outcome of [{ kind: 'error' as const, duration: 1 }, { kind: 'cancelled' as const, duration: 1 }]) {
      const contradictory = patch(good, { outcome })
      expect(v4aLintNeedsAttention(contradictory)).toBe(false)
      expect(plain(contradictory)).not.toContain('Lint reported an error')
    }
    expect(detailOf(patch(good))).toMatchObject({ tool: 'patch', v4aLint: { errors: [{ path: 'x.py', output: 'syntax problem' }] } })
  })
})
