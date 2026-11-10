import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId } from '../core/ids.js'
import { history } from '../transcript/history.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { parseJson, record } from '../wire/json.js'

import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const rows = (root: NodeJson) => nodes(root).filter(n => n.p?.['role'] === 'omp.tool.search.count')
const notices = (root: NodeJson) => nodes(root).filter(n => n.p?.['role'] === 'omp.tool.notice').map(n => n.p?.['spans'])
const args = { output_mode: 'count', pattern: 'test' }
const card = (result: unknown) => tree(toolNode(call('search_files', args, { result }), 0))

describe('Hermes per-file search counts', () => {
  it('projects pinned SearchResult, grouped detail and retained history without inventing a sum', () => {
    const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/search-counts-core.py')], {
      cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
    })
    const fixture = parseJson(raw)
    if (!Array.isArray(fixture)) throw new Error('expected results')
    const result = record(fixture[0])
    expect(result).toMatchObject({ counts: { 'src/a.py': 2, 'src/b.py': 3 }, total_count: 8, truncated: true })
    const live = card(result)
    expect(rows(live).map(n => n.p?.['spans'])).toEqual([
      [{ s: 'path', t: 'src/a.py' }, { t: '  2' }], [{ s: 'path', t: 'src/b.py' }, { t: '  3' }]
    ])
    expect(live.p?.['meta']).toEqual(['2 retained counts shown', 'Hermes total count: at least 8', 'Search results truncated upstream'])
    const details = toolDetail(call('search_files', args, { result }), 0).map(tree).flatMap(nodes)
    expect(details.filter(n => n.p?.['role'] === 'omp.tool.search.count')).toHaveLength(2)
    expect(details.filter(n => n.p?.['role'] === 'omp.tool.notice').map(n => n.p?.['spans'])).toEqual([
      [{ s: 'muted', t: 'Hermes total count: at least 8' }], [{ s: 'muted', t: 'Search results truncated upstream' }]
    ])
    let n = 0
    const entries = history({ kept: [], id: p => entryId(`${p}${++n}`), messages: [
      { role: 'user', text: 'count' },
      { role: 'tool', name: 'search_files', tool_call_id: 'search', args, content: JSON.stringify(result) }
    ] })
    const turn = entries.find(e => e.kind === 'turn')
    const block = turn?.blocks.find(b => b.kind === 'tool')
    if (block?.kind !== 'tool') throw new Error('missing replay tool')
    const replay = tree(toolNode(block.call, 0))
    expect(rows(replay).map(n => n.p?.['spans'])).toEqual(rows(live).map(n => n.p?.['spans']))
    expect(replay.p?.['meta']).toEqual(live.p?.['meta'])
    const empty = record(fixture[1])
    expect(empty).toEqual({ total_count: 0 })
    expect(notices(card(empty))).toContainEqual([{ s: 'muted', t: 'No per-file counts returned' }])
  })

  it('bounds rows and paths and escapes unsafe single-line characters', () => {
    const counts: Record<string, unknown> = { ['__proto__']: 0, ['a\n\t\u001b\u2028\u2029\u206a\ud800']: 1, ['\u001b' + 'x'.repeat(300)]: 2 }
    for (let i = 0; i < 201; i++) counts[`file-${i}`] = i
    const root = card({ counts })
    expect(rows(root)).toHaveLength(200)
    expect(rows(root)[0]?.p?.['spans']).toEqual([{ s: 'path', t: '__proto__' }, { t: '  0' }])
    expect(rows(root)[1]?.p?.['spans']).toEqual([{ s: 'path', t: 'a\\u000a\\u0009\\u001b\\u2028\\u2029\\u206a\\ud800' }, { t: '  1' }])
    expect(notices(root)).toEqual(expect.arrayContaining([
      [{ s: 'muted', t: 'Count entries clipped in view' }],
      [{ s: 'muted', t: 'Count paths clipped in view' }],
      [{ s: 'muted', t: 'Control characters escaped in view' }]
    ]))
    expect(nodes(root).some(n => n.p?.['href'] || n.p?.['actions'])).toBe(false)
  })

  it('distinguishes empty, missing, malformed, filtered and invalid values', () => {
    expect(notices(card({ counts: 'bad', total_count: 0 }))).toContainEqual([{ s: 'muted', t: 'Per-file counts unavailable' }])
    expect(notices(card({ total_count: 4, _omitted: 'filtered' }))).toEqual(expect.arrayContaining([
      [{ s: 'muted', t: 'Hermes omitted some search results' }], [{ s: 'muted', t: 'Per-file counts unavailable' }]
    ]))
    const bad = card({ counts: { a: -1, b: 0.5, c: Infinity, d: '1', good: 0 } })
    expect(rows(bad)).toHaveLength(1)
    expect(notices(bad)).toContainEqual([{ s: 'muted', t: 'Invalid count entries omitted' }])
    expect(notices(card({ counts: {} }))).toContainEqual([{ s: 'muted', t: 'No per-file counts returned' }])
    expect(notices(card({}))).toContainEqual([{ s: 'muted', t: 'Per-file counts unavailable' }])
  })

  it('retains error/cancel status and avoids interpreting other result modes as counts', () => {
    const failed = call('search_files', args, { result: { counts: { a: 1 }, error: 'failed\u001b' }, outcome: { duration: 1, kind: 'error' } })
    const root = tree(toolNode(failed, 0))
    expect(root.p?.['status']).toBe('error')
    expect(nodes(root).find(n => n.p?.['role'] === 'omp.tool.error')?.p?.['spans']).toEqual([{ s: 'error', t: 'failed\\u001b' }])
    const cancelled = call('search_files', args, { result: { counts: { a: 1 } }, outcome: { duration: 1, kind: 'cancelled' } })
    expect(notices(tree(toolNode(cancelled, 0))).some(x => JSON.stringify(x).includes('Interrupted'))).toBe(true)
    const mixed = card({ matches: [{ path: 'a', line: 1, content: 'hit' }], counts: { ignored: 5 } })
    expect(rows(mixed)).toHaveLength(0)
    expect(nodes(mixed).find(n => n.k === 'code')?.p?.['text']).toBe('hit')
    expect(rows(tree(toolNode(call('search_files', {}, { result: { counts: { ignored: 5 } } }), 0)))).toHaveLength(0)
  })
})
