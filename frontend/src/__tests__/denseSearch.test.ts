import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId } from '../core/ids.js'
import { retainedResults } from '../tool-results.js'
import { history } from '../transcript/history.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { parseJson, record } from '../wire/json.js'

import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const codes = (root: NodeJson) => nodes(root).filter(n => n.k === 'code')
const card = (result: unknown, args: Record<string, unknown> = {}) => tree(toolNode(call('search_files', args, { result }), 0))

describe('Hermes dense search cards', () => {
  it('replays search, generic and terminal cards with their separate retained-result and language rules', () => {
    const generic = 'g'.repeat(4001)
    const denseText = 'dense result' + 'x'.repeat(4001)
    let n = 0
    const entries = history({ kept: [], id: prefix => entryId(`${prefix}${++n}`), messages: [
      { role: 'user', text: 'inspect results' },
      { role: 'tool', name: 'search_files', tool_call_id: 'dense', args: { pattern: 'hit' }, content: JSON.stringify({ matches_text: denseText, total_count: 5, truncated: true, _omitted: 'filtered', error: 'dense failed' }) },
      { role: 'tool', name: 'search_files', tool_call_id: 'structured', args: { pattern: 'hit' }, content: JSON.stringify({ matches: [{ path: 'file.constructor', line: 1, content: 'hit' }], total_count: 2, _omitted: 'filtered', error: 'structured failed' }) },
      { role: 'tool', name: 'search_files', tool_call_id: 'count', args: { pattern: 'hit', output_mode: 'count' }, content: JSON.stringify({ counts: { 'file.py': 2 }, total_count: 8, truncated: true, _omitted: 'filtered', error: 'count failed' }) },
      { role: 'tool', name: 'read_file', tool_call_id: 'unchanged', args: { path: 'file.constructor' }, content: JSON.stringify({ status: 'unchanged', dedup: true, content_returned: false }) },
      { role: 'tool', name: 'read_file', tool_call_id: 'clamped', args: { path: 'file.constructor' }, content: JSON.stringify({ content: '1|part', total_lines: 1, truncated: true, truncated_lines: true, truncated_by: 'bytes', next_offset: 2 }) },
      { role: 'tool', name: 'custom_result', tool_call_id: 'generic', args: {}, content: generic },
      { role: 'tool', name: 'terminal', tool_call_id: 'terminal', args: { command: 'curl https://user:secret@[' }, content: JSON.stringify({ exit_code: 2, output: 'curl failed' }) }
    ] })
    const calls = entries.flatMap(e => e.kind === 'turn' ? e.blocks.flatMap(b => b.kind === 'tool' ? [b.call] : []) : [])
    const dense = calls.find(c => c.id === 'dense')
    const structured = calls.find(c => c.id === 'structured')
    const counted = calls.find(c => c.id === 'count')
    const terminal = calls.find(c => c.id === 'terminal')
    const unchanged = calls.find(c => c.id === 'unchanged')
    const clamped = calls.find(c => c.id === 'clamped')
    if (!dense || !structured || !counted || !terminal || !unchanged || !clamped) throw new Error('missing replay tool')
    const denseCard = tree(toolNode(dense, 0))
    expect(codes(denseCard)[0]?.p?.['text']).toBe(denseText.slice(0, 4000))
    expect(denseCard.p?.['meta']).toEqual(['Hermes total: At least 5 matches', 'Hermes omitted some search results', 'Search results truncated upstream', 'Search text clipped in view'])
    const structuredCard = tree(toolNode(structured, 0))
    expect(structuredCard.p?.['meta']).toEqual(['Hermes total: 2 matches · 1 file shown', 'Hermes omitted some search results'])
    const code = codes(structuredCard)[0]
    expect(code?.p?.['text']).toBe('hit')
    expect(code?.p?.['lang']).toBeUndefined()
    const countCard = tree(toolNode(counted, 0))
    expect(nodes(countCard).find(node => node.p?.['role'] === 'omp.tool.search.count')?.p?.['spans']).toEqual([{ s: 'path', t: 'file.py' }, { t: '  2' }])
    expect(countCard.p?.['meta']).toEqual(['1 retained count shown', 'Hermes total count: at least 8', 'Hermes omitted some search results', 'Search results truncated upstream'])
    for (const [call, rendered, reason] of [[dense, denseCard, 'dense failed'], [structured, structuredCard, 'structured failed'], [counted, countCard, 'count failed']] as const) {
      expect(rendered.p?.['status']).toBe('error')
      expect(nodes(rendered).filter(node => node.p?.['role'] === 'omp.tool.error').map(node => node.p?.['spans'])).toEqual([[{ s: 'error', t: reason }]])
      expect(toolDetail(call, 0).map(tree).flatMap(nodes).filter(node => node.p?.['role'] === 'omp.tool.error').map(node => node.p?.['spans'])).toEqual([[{ s: 'error', t: reason }]])
    }
    const stubCard = tree(toolNode(unchanged, 0))
    expect(stubCard.p?.['meta']).toContain('Unchanged; Hermes did not return file content')
    expect(codes(stubCard)).toHaveLength(0)
    const clampedCard = tree(toolNode(clamped, 0))
    expect(codes(clampedCard)[0]?.p).toMatchObject({ text: 'part' })
    expect(codes(clampedCard)[0]?.p?.['lang']).toBeUndefined()
    expect(clampedCard.p?.['meta']).toEqual(['1 lines', 'Hermes marked this read as truncated', 'Some lines were clipped; their missing text may not be recoverable by offset', 'Hermes continuation offset: 2'])
    const clampedDetail = toolDetail(clamped, 0).map(tree).flatMap(nodes)
    expect(clampedDetail.filter(node => node.p?.['role'] === 'omp.tool.notice')).toHaveLength(3)
    const shell = tree(toolNode(terminal, 0))
    expect(shell.p).toMatchObject({ name: 'bash', title: 'Fetch a URL' })
    expect(nodes(shell).find(node => node.k === 'ansi')?.p?.['text']).toBe('curl failed')
    expect(retainedResults(entries).map(result => result.text)).toEqual([generic])
  })

  it('projects the actual pinned SearchResult and retained history JSON', () => {
    const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/search-result-core.py')], {
      cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
    })
    const result = parseJson(raw)
    if (!Array.isArray(result)) throw new Error('expected serialized results')
    const short = record(result[0])
    const payload = record(result[1])
    expect(short?.['matches_text']).toBeUndefined()
    expect(codes(card(short))[0]?.p?.['text']).toBe('  hit 1\n  hit 2\n  hit 3\n  hit 4')
    expect(payload?.['matches']).toBeUndefined()
    expect(payload?.['matches_format']).toContain('path-grouped')
    expect(payload?.['matches_text']).toBe('src/a.py\n  1:   hit 1\n  2:   hit 2\n  3:   hit 3\n  4:   hit 4\n  5:   hit 5')
    const live = card(payload, { pattern: 'hit' })
    expect(codes(live)[0]?.p).toMatchObject({ lang: 'text', text: payload?.['matches_text'] })
    expect(live.p?.['meta']).toEqual(['At least 7 matches', 'Search results truncated upstream'])

    let n = 0
    const entries = history({ kept: [], id: prefix => entryId(`${prefix}${++n}`), messages: [
      { role: 'user', text: 'find it' },
      { role: 'tool', name: 'search_files', tool_call_id: 'search', args: { pattern: 'hit' }, content: JSON.stringify(payload) }
    ] })
    const turn = entries.find(e => e.kind === 'turn')
    const block = turn?.blocks.find(b => b.kind === 'tool')
    expect(block?.kind).toBe('tool')
    if (block?.kind !== 'tool') throw new Error('missing replay tool')
    const replay = tree(toolNode(block.call, 0))
    expect(codes(replay)[0]?.p).toMatchObject({ lang: 'text', text: payload?.['matches_text'] })
    expect(replay.p?.['meta']).toEqual(live.p?.['meta'])
  })

  it('bounds dense output without splitting pairs and escapes terminal and bidi controls', () => {
    const root = card({ matches_text: 'x'.repeat(3999) + '😀\u001b[31m\u202etest', total_count: 9 })
    const content = codes(root)[0]?.p?.['text']
    expect(content).toBe('x'.repeat(3999))
    expect(root.p?.['meta']).toEqual(['9 matches', 'Search text clipped in view'])
    const unsafe = card({ matches_text: 'a\n\tb\u001b[31m\u202ex\ud800' })
    expect(codes(unsafe)[0]?.p?.['text']).toBe('a\n\tb\\u001b[31m\\u202ex\\ud800')
    expect(unsafe.p?.['meta']).toEqual(['Control characters escaped in view'])
  })

  it('does not invent counts and signals upstream and display limits separately', () => {
    for (const bad of [undefined, -1, 2.5, Infinity, '9']) {
      const root = card({ matches_text: 'visible', total_count: bad, truncated: true })
      expect(root.p?.['meta']).toEqual(['Search results truncated upstream'])
    }
    const root = card({ matches_text: 'x'.repeat(4001), total_count: 9, truncated: true })
    expect(root.p?.['meta']).toEqual(['At least 9 matches', 'Search results truncated upstream', 'Search text clipped in view'])
    const detail = toolDetail(call('search_files', {}, { result: { matches_text: 'x'.repeat(4001), total_count: 9, truncated: true } }), 0).map(tree).flatMap(nodes)
    const notices = detail.filter(n => n.p?.['role'] === 'omp.tool.notice')
    expect(notices.map(n => n.p?.['spans'])).toEqual([
      [{ s: 'muted', t: 'At least 9 matches' }],
      [{ s: 'muted', t: 'Search results truncated upstream' }],
      [{ s: 'muted', t: 'Search text clipped in view' }]
    ])
    for (const matches of [[], [null]]) {
      expect(codes(card({ matches, matches_text: 'retained' }))[0]?.p?.['text']).toBe('retained')
    }
  })

  it('keeps structured matches and file mode, and marks the file display cap', () => {
    const structured = card({ matches: [{ path: 'a.py', line: 1, content: 'hello' }], total_count: 1, matches_text: 'ignored' })
    expect(codes(structured)[0]?.p?.['text']).toBe('hello')
    expect(structured.p?.['meta']).toEqual(['1 match · 1 file shown'])
    const files = card({ files: Array.from({ length: 201 }, (_, i) => `f${i}`), total_count: 250, truncated: true }, { target: 'files' })
    expect(nodes(files).filter(n => n.p?.['role'] === 'omp.tool.file')).toHaveLength(200)
    expect(files.p?.['meta']).toEqual(['At least 250 files', 'Search results truncated upstream', 'Showing 200 of 201 retained files'])
  })

  it('keeps error and cancellation status alongside partial dense output', () => {
    const failed = call('search_files', {}, { result: { matches_text: 'partial', error: 'failed\u001b' }, outcome: { duration: 1, kind: 'error' } })
    const root = tree(toolNode(failed, 0))
    expect(root.p?.['status']).toBe('error')
    expect(nodes(root).find(n => n.p?.['role'] === 'omp.tool.error')?.p?.['spans']).toEqual([{ s: 'error', t: 'failed\\u001b' }])
    expect(toolDetail(failed, 0).map(tree).flatMap(nodes).some(n => n.p?.['role'] === 'omp.tool.error')).toBe(true)
    const cancelled = call('search_files', {}, { result: { matches_text: 'partial' }, outcome: { duration: 1, kind: 'cancelled' } })
    const stopped = tree(toolNode(cancelled, 0))
    expect(codes(stopped)[0]?.p?.['text']).toBe('partial')
    expect(nodes(stopped).some(n => n.p?.['role'] === 'omp.tool.notice')).toBe(true)
  })
})
