import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { ToolCall } from '../model.js'
import { detailOf } from '../tools/detail.js'
import { history } from '../transcript/history.js'
import { Transcript } from '../transcript/store.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { parseJson, record } from '../wire/json.js'
import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const title = 'Lint reported an error'
const nodes = (n: NodeJson): NodeJson[] => [n, ...(n.c ?? []).flatMap(nodes)]
const write = (result: unknown, more: Partial<ToolCall> = {}) => call('write_file', { path: 'x.py', content: 'def broken(:\n    pass\n' }, { result, ...more })
const output = (n: NodeJson) => nodes(n).find(x => x.p?.['role'] === 'omp.tool.lint.output')?.p?.['text']

/** The producer's lint result and actual write serializer, no disk write or provider. */
function produced(): Record<string, unknown>[] {
  const code = `from tools.file_operations_lint import LintMixin
from tools.file_operations_common import WriteResult
import json
lint = LintMixin()
cases = [('x = 1\\n','def broken(:\\n    pass\\n'), ('def broken(:\\n pass\\n','def broken(:\\n pass\\n'), ('x = 1\\n','x = 2\\n')]
print(json.dumps([WriteResult(bytes_written=23,verified=True,lint=lint._check_lint_delta('x.py',a,b).to_dict()).to_dict() for a,b in cases]))`
  const data = parseJson(execFileSync('python3', ['-c', code], { cwd: resolve('.hermes-src'), encoding: 'utf8' }))
  if (!Array.isArray(data)) throw new Error('missing producer output')
  return data.map(item => { const r = record(item); if (!r) throw new Error('invalid result'); return r })
}

describe('write_file lint disclosure', () => {
  it('shows real retained producer diagnostics while preserving a successful write and source', () => {
    const [result, preexisting, clean] = produced()
    expect(result).toMatchObject({ verified: true, lint: { status: 'error', output: expect.stringContaining('SyntaxError') } })
    const c = write(result)
    const card = tree(toolNode(c, 0))
    expect(card.p).toMatchObject({ name: 'write', status: 'done', collapsed: false, meta: ['2 lines', title] })
    expect(output(card)).toContain('SyntaxError')
    expect(JSON.stringify(toolDetail(c, 0).map(tree))).toContain('SyntaxError')
    expect(nodes(card).find(n => n.k === 'code')?.p?.['text']).toBe('def broken(:\n    pass')
    expect(c.result).toBe(result)
    expect(c.outcome.kind).toBe('done')
    const existing = tree(toolNode(write(preexisting), 0))
    expect(JSON.stringify(existing)).toContain('Pre-existing lint errors')
    expect(JSON.stringify(tree(toolNode(write(clean), 0)))).not.toContain(title)
  })

  it('keeps the result through actual tool-complete and retained history paths', () => {
    const [result] = produced()
    const store = new Transcript()
    store.toolComplete({ tool_id: 'live', name: 'write_file', args: { path: 'x.py', content: 'x' }, result }, 100)
    const live = store.call(toolCallId('live'))
    if (!live) throw new Error('missing live call')
    expect(live.outcome.kind).toBe('done')
    expect(JSON.stringify(tree(toolNode(live, 100)))).toContain(title)
    const entries = history({ kept: [], id: entryId, messages: [
      { role: 'tool', name: 'write_file', tool_call_id: 'saved', args: { path: 'x.py', content: 'x' }, content: JSON.stringify(result) }
    ] })
    const turn = entries.find(e => e.kind === 'turn')
    const saved = turn?.blocks.find(b => b.kind === 'tool')
    if (saved?.kind !== 'tool') throw new Error('missing replay call')
    expect(JSON.stringify(tree(toolNode(saved.call, 100)))).toContain(title)
  })

  it('ignores absent, malformed, non-error, inherited and patch lint reports', () => {
    const values: unknown[] = [undefined, null, {}, { status: 'ok', output: '' }, { status: 'skipped', message: 'unavailable' },
      { status: 'error' }, { status: 'error', output: 4 }, { status: 'error', output: 'x', message: 7 },
      Object.assign(Object.create({ status: 'error' }), { output: 'x' }), '{"status":"error","output":"x"}']
    for (const lint of values) expect(JSON.stringify(tree(toolNode(write({ lint }), 0)))).not.toContain(title)
    const inherited = Object.assign(Object.create({ lint: { status: 'error', output: 'x' } }), {})
    expect(JSON.stringify(tree(toolNode(write(inherited), 0)))).not.toContain(title)
    const inheritedMessage = Object.assign(Object.create({ message: 'inherited text' }), { status: 'error', output: 'x' })
    expect(JSON.stringify(tree(toolNode(write({ lint: inheritedMessage }), 0)))).not.toContain('inherited text')
    expect(JSON.stringify(tree(toolNode(call('patch', { path: 'x.py' }, { result: { lint: { status: 'error', output: 'x' } } }), 0)))).not.toContain(title)
  })

  it('bounds and sanitizes untrusted lint text without hiding its clipping', () => {
    const bad = 'hello\u001b[31mred\u001b[0m\u202e\u2028\u206a\ud800' + 'x'.repeat(6000)
    const card = tree(toolNode(write({ lint: { status: 'error', output: bad, message: bad } }), 0))
    const actual = output(card)
    expect(typeof actual).toBe('string')
    expect(actual).toContain('hello')
    expect(actual).toContain('\\u202e')
    expect(actual).toContain('\\u2028\\u206a\\ud800')
    expect(actual).not.toContain('\u001b')
    expect(JSON.stringify(card)).toContain('Lint report clipped in view')
    expect(JSON.stringify(card)).toContain('Lint report control characters escaped in view')
    expect(JSON.stringify(card).length).toBeLessThan(12000)
    const edge = tree(toolNode(write({ lint: { status: 'error', output: 'x'.repeat(1999) + '😀!' } }), 0))
    expect(output(edge)).toBe('x'.repeat(1999))
    expect(JSON.stringify(edge)).toContain('Lint report clipped in view')
  })

  it('does not show an early running result and leaves unrelated LSP content intact', () => {
    const result = { lint: { status: 'error', output: 'syntax' }, lsp_diagnostics: 'Legacy LSP diagnostic' }
    const running = write(result, { outcome: { kind: 'running' } })
    expect(JSON.stringify(tree(toolNode(running, 0)))).not.toContain(title)
    const done = write(result)
    expect(JSON.stringify(tree(toolNode(done, 0)))).toContain('Legacy LSP diagnostic')
    expect(detailOf(done)).toMatchObject({ tool: 'write_file', lintError: { output: 'syntax' } })
  })
})
