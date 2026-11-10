import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId } from '../core/ids.js'
import { history } from '../transcript/history.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { record } from '../wire/json.js'

import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const errors = (roots: NodeJson[]) => roots.flatMap(nodes).filter(n => n.p?.['role'] === 'omp.tool.error')
const notices = (roots: NodeJson[]) => roots.flatMap(nodes).filter(n => n.p?.['role'] === 'omp.tool.notice').map(n => n.p?.['spans'])
const make = (result: unknown) => call('web_extract', { urls: ['https://original.example'] }, { result })

describe('web extraction entry failures', () => {
  it('shows actual pinned no-provider failures in order in cards, grouped detail and retained replay', () => {
    const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/web-errors-core.py')], {
      cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
    })
    const payload = record(raw)
    const entries = payload?.['results']
    if (!Array.isArray(entries)) throw new Error('expected results')
    expect(entries).toHaveLength(2)
    expect(record(entries[0])?.['error']).toContain('private or internal network')
    expect(record(entries[1])?.['error']).toContain('Invalid URL item at index 1')
    const c = make(payload)
    const root = tree(toolNode(c, 0))
    const detail = toolDetail(c, 0).map(tree)
    expect(root.p).toMatchObject({ collapsed: false, meta: ['2 entries · 0 chars'], status: 'done' })
    const text = errors([root]).map(n => n.p?.['spans'])
    expect(text).toEqual([
      [{ s: 'error', t: 'Extraction failed: Blocked: URL targets a private or internal network address' }],
      [{ s: 'error', t: "Extraction failed: Invalid URL item at index 1: expected a URL string or an object with a string 'url' or 'href' field" }]
    ])
    expect(errors(detail).map(n => n.p?.['spans'])).toEqual(text)
    expect(JSON.stringify(errors([root]))).not.toContain('original.example')
    let n = 0
    const historyEntries = history({ kept: [], id: p => entryId(`${p}${++n}`), messages: [
      { role: 'user', text: 'fetch' },
      { role: 'tool', name: 'web_extract', tool_call_id: 'f', args: {}, content: raw }
    ] })
    const turn = historyEntries.find(e => e.kind === 'turn')
    const block = turn?.blocks.find(b => b.kind === 'tool')
    if (block?.kind !== 'tool') throw new Error('missing replay tool')
    expect(errors([tree(toolNode(block.call, 0))]).map(n => n.p?.['spans'])).toEqual(text)
  })

  it('preserves mixed page order, successful links and partial output without inventing success', () => {
    const result = { results: [
      { title: 'Success', url: 'https://a.example/', content: 'first' },
      { url: 'https://b.example/', content: 'partial', error: 'timed out' },
      { title: '', url: '', content: '', error: 'bad entry' }
    ] }
    const root = tree(toolNode(make(result), 0))
    expect(root.p).toMatchObject({ status: 'done', meta: ['3 entries · 12 chars'] })
    const all = nodes(root)
    const first = all.findIndex(n => n.k === 'md' && n.p?.['text'] === 'first')
    const partial = all.findIndex(n => n.k === 'md' && n.p?.['text'] === 'partial')
    const timed = all.findIndex(n => (JSON.stringify(n.p?.['spans']) ?? '').includes('timed out'))
    const bad = all.findIndex(n => (JSON.stringify(n.p?.['spans']) ?? '').includes('bad entry'))
    expect(first).toBeLessThan(partial)
    expect(partial).toBeLessThan(timed)
    expect(timed).toBeLessThan(bad)
    expect(JSON.stringify(root)).toContain('https://a.example/')
    expect(errors([root])).toHaveLength(2)
    expect(all.filter(n => n.p?.['role'] === 'omp.tool.source')).toHaveLength(2)
  })

  it('bounds and escapes hostile error text and preserves existing page clipping', () => {
    const error = 'x'.repeat(999) + '😀\u001b\u202e'
    const root = tree(toolNode(make({ results: [{ content: 'a'.repeat(4001), error }, { error: 'bad\u001b\u2028\u206a\ud800' }] }), 0))
    expect(errors([root])[0]?.p?.['spans']).toEqual([{ s: 'error', t: `Extraction failed: ${'x'.repeat(999)}` }])
    expect(errors([root])[1]?.p?.['spans']).toEqual([{ s: 'error', t: 'Extraction failed: bad\\u001b\\u2028\\u206a\\ud800' }])
    expect(notices([root])).toContainEqual([{ s: 'muted', t: 'Error text clipped in view' }])
    expect(notices([root])).toContainEqual([{ s: 'muted', t: 'Error control characters escaped in view' }])
    expect(nodes(root).find(n => n.k === 'md')?.p?.['text']).toBe('a'.repeat(4000) + '\n…')
  })

  it('preserves call errors and cancellation without duplicating a repeated reason', () => {
    const result = { error: 'network failed', results: [{ error: 'network failed', content: 'partial' }] }
    const failed = call('web_extract', {}, { result, outcome: { duration: 1, kind: 'error' } })
    const root = tree(toolNode(failed, 0))
    expect(root.p?.['status']).toBe('error')
    expect(errors([root])).toHaveLength(1)
    expect(errors(toolDetail(failed, 0).map(tree))).toHaveLength(1)
    const other = call('web_extract', {}, { result: { error: 'whole call failed', results: [{ error: 'entry failed' }] }, outcome: { duration: 1, kind: 'error' } })
    expect(errors([tree(toolNode(other, 0))])).toHaveLength(2)
    const stopped = call('web_extract', {}, { result, outcome: { duration: 1, kind: 'cancelled' } })
    const stoppedRoot = tree(toolNode(stopped, 0))
    expect(stoppedRoot.p?.['status']).toBe('cancelled')
    expect(notices([stoppedRoot]).some(n => JSON.stringify(n).includes('Interrupted'))).toBe(true)
  })

  it('does not turn malformed error fields into failures', () => {
    const root = tree(toolNode(make({ results: [{ error: null }, { error: 42 }, { error: ' \t' }, { error: { message: 'bad' } }] }), 0))
    expect(errors([root])).toHaveLength(0)
    expect(root.p?.['meta']).toEqual(['4 pages · 0 chars'])
  })
})
