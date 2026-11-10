import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { ToolCall } from '../model.js'
import { detailOf } from '../tools/detail.js'
import { patchNoWriteReported } from '../tools/patch-noop.js'
import { history } from '../transcript/history.js'
import { Transcript } from '../transcript/store.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { parseJson, record } from '../wire/json.js'
import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const args = { path: 'x.py', old_string: 'x = 1', new_string: 'def broken(:' }
const title = 'Lint reported an error'
const nodes = (n: NodeJson): NodeJson[] => [n, ...(n.c ?? []).flatMap(nodes)]
const patch = (result: unknown, more: Partial<ToolCall> = {}) => call('patch', args, { result, ...more })

/** No-disk in-memory transport, actual pinned patch_replace and lint helper. */
function produced(): Record<string, unknown>[] {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/patch-lint-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const data = parseJson(raw)
  if (!Array.isArray(data)) throw new Error('expected result array')
  return data.map(item => { const r = record(item); if (!r) throw new Error('invalid result'); return r })
}

describe('replace patch lint disclosure', () => {
  it('shows the real pinned result and diff, without changing successful patch outcome', () => {
    const [bad, clean] = produced()
    expect(bad).toMatchObject({ success: true, lint: { status: 'error', output: expect.stringContaining('SyntaxError') } })
    const c = patch(bad)
    const card = tree(toolNode(c, 0))
    expect(card.p).toMatchObject({ name: 'edit', status: 'done', collapsed: false })
    expect(JSON.stringify(card)).toContain(title)
    expect(JSON.stringify(card)).toContain('SyntaxError')
    expect(nodes(card).find(n => n.k === 'diff')?.p?.['text']).toContain('def broken(:')
    expect(JSON.stringify(toolDetail(c, 0).map(tree))).toContain('SyntaxError')
    expect(c.result).toBe(bad)
    expect(c.outcome.kind).toBe('done')
    expect(JSON.stringify(tree(toolNode(patch(clean), 0)))).not.toContain(title)
  })

  it('survives tool completion and retained history', () => {
    const [result] = produced()
    const store = new Transcript()
    store.toolComplete({ tool_id: 'live', name: 'patch', args, result }, 100)
    const live = store.call(toolCallId('live'))
    if (!live) throw new Error('missing live patch')
    expect(live.outcome.kind).toBe('done')
    expect(JSON.stringify(tree(toolNode(live, 100)))).toContain(title)
    const entries = history({ kept: [], id: entryId, messages: [
      { role: 'tool', name: 'patch', tool_call_id: 'saved', args, content: JSON.stringify(result) }
    ] })
    const turn = entries.find(e => e.kind === 'turn')
    const saved = turn?.blocks.find(b => b.kind === 'tool')
    if (saved?.kind !== 'tool') throw new Error('missing replay patch')
    expect(JSON.stringify(tree(toolNode(saved.call, 100)))).toContain(title)
  })

  it('does not treat V4A, ambiguous args, partial, failed or contradictory results as replace reports', () => {
    const good = { success: true, lint: { status: 'error', output: 'syntax' } }
    for (const badArgs of [{}, { path: 'x.py' }, { ...args, mode: 'patch' }, { ...args, patch: 'v4a' },
      { ...args, mode: null }, { ...args, old_string: 1 }, { ...args, new_string: undefined }]) {
      expect(JSON.stringify(tree(toolNode(call('patch', badArgs, { result: good }), 0)))).not.toContain(title)
    }
    for (const result of [{ ...good, success: false }, { ...good, success: 'true' }, { ...good, error: 'failed' },
      { ...good, partial: true }, { ...good, truncated: true }, { ...good, status: 'failed' }, { ...good, ok: false },
      { ...good, exit_code: 1 }, { ...good, is_error: true }, { ...good, failed: true }, { ...good, cancelled: true },
      { ...good, files_created: ['new'] }, { ...good, files_deleted: ['old'] }]) {
      expect(JSON.stringify(tree(toolNode(patch(result), 0)))).not.toContain(title)
    }
    for (const lint of [undefined, { status: 'ok', output: '' }, { status: 'skipped', message: 'unavailable' },
      { status: 'error', output: 1 }, { status: 'error', output: 'x', message: 2 }, { 'x.py': { status: 'error', output: 'x' } }]) {
      expect(JSON.stringify(tree(toolNode(patch({ success: true, lint }), 0)))).not.toContain(title)
    }
  })

  it('preserves #124 no-write on contradictory no-change and existing LSP content', () => {
    const noChange = patch({ success: true, no_change: true, lint: { status: 'error', output: 'syntax' } })
    expect(patchNoWriteReported(noChange)).toBe(true)
    const rendered = JSON.stringify(tree(toolNode(noChange, 0)))
    expect(rendered).toContain('Target text appears present; no write performed')
    expect(rendered).not.toContain(title)
    const report = patch({ success: true, lint: { status: 'error', output: 'syntax', message: 'Pre-existing lint errors' }, lsp_diagnostics: 'Legacy LSP' })
    const card = JSON.stringify(tree(toolNode(report, 0)))
    expect(card).toContain('Pre-existing lint errors')
    expect(card).toContain('Legacy LSP')
    expect(detailOf(report)).toMatchObject({ tool: 'patch', lintError: { output: 'syntax' } })
  })

  it('retains bounded sanitized diagnostic display and original status', () => {
    const c = patch({ success: true, lint: { status: 'error', output: 'bad\u001b\u2028' + 'x'.repeat(3000) } })
    const card = tree(toolNode(c, 0))
    const text = JSON.stringify(card)
    expect(text).toContain('\\\\u001b\\\\u2028')
    expect(text).toContain('Lint report clipped in view')
    expect(text).toContain('Lint report control characters escaped in view')
    const running = patch({ success: true, lint: { status: 'error', output: 'bad' } }, { outcome: { kind: 'running' } })
    expect(JSON.stringify(tree(toolNode(running, 0)))).not.toContain(title)
    for (const outcome of [{ kind: 'error' as const, duration: 1 }, { kind: 'cancelled' as const, duration: 1 }]) {
      expect(tree(toolNode(patch({ success: true, lint: { status: 'error', output: 'bad' } }, { outcome }), 0)).p?.['status']).toBe(outcome.kind)
    }
  })
})
