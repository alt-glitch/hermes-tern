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
const notices = (root: NodeJson[]) => root.flatMap(nodes).filter(n => n.p?.['role'] === 'omp.tool.notice').map(n => n.p?.['spans'])
const omission = [{ s: 'muted', t: 'Hermes omitted some search results' }]
const make = (result: unknown, args: Record<string, unknown> = {}) => call('search_files', args, { result })

describe('search result omissions', () => {
  it('discloses actual pinned filter and serializer outputs in every card and detail, including replay', () => {
    const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/search-omissions-core.py')], {
      cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
    })
    const fixture = parseJson(raw)
    if (!Array.isArray(fixture)) throw new Error('expected results')
    for (const [i, value] of fixture.entries()) {
      const result = record(value)
      expect(JSON.stringify(result)).not.toContain('withheld')
      expect(result?.['_omitted']).toContain('result(s) omitted')
      const args = i >= 2 ? { target: 'files' } : {}
      const c = make(result, args)
      const root = tree(toolNode(c, 0))
      expect(root.p?.['meta']).toContain('Hermes omitted some search results')
      expect(notices([root])).toContainEqual(omission)
      expect(notices(toolDetail(c, 0).map(tree))).toContainEqual(omission)
      let n = 0
      const entries = history({ kept: [], id: p => entryId(`${p}${++n}`), messages: [
        { role: 'user', text: 'search' }, { role: 'tool', name: 'search_files', tool_call_id: `s${i}`, args, content: JSON.stringify(result) }
      ] })
      const turn = entries.find(e => e.kind === 'turn')
      const block = turn?.blocks.find(b => b.kind === 'tool')
      if (block?.kind !== 'tool') throw new Error('missing replay tool')
      expect(notices([tree(toolNode(block.call, 0))])).toContainEqual(omission)
    }
    const dense = tree(toolNode(make(record(fixture[0])), 0))
    expect(dense.p?.['meta']).toContain('Hermes total: At least 6 matches')
    expect(notices([dense])).toContainEqual([{ s: 'muted', t: 'Hermes total: At least 6 matches' }])
    const files = tree(toolNode(make(record(fixture[2]), { target: 'files' }), 0))
    expect(files.p?.['meta']).toContain('Hermes total: 2 files')
  })

  it('shows a constant safe notice and ignores absent or non-string omission fields', () => {
    for (const bad of [undefined, null, '', ' \n\t', false, 1, {}, []]) {
      expect(notices([tree(toolNode(make({ _omitted: bad, matches: [{ path: 'a', line: 1, content: 'hit' }] }), 0))])).not.toContainEqual(omission)
    }
    const raw = 'withheld\u001b[31m\u202e secret'
    const root = tree(toolNode(make({ _omitted: raw, matches_text: 'retained' }), 0))
    expect(notices([root])).toContainEqual(omission)
    expect(JSON.stringify(root)).not.toContain('withheld')
    expect(JSON.stringify(root)).not.toContain('secret')
  })

  it('keeps clipping, cancellation and error visible with the omission notice', () => {
    const result = { _omitted: 'filtered', truncated: true, total_count: 20, matches_text: 'x'.repeat(4001), error: 'failed' }
    const failed = call('search_files', {}, { result, outcome: { duration: 1, kind: 'error' } })
    const root = tree(toolNode(failed, 0))
    expect(root.p?.['status']).toBe('error')
    expect(notices([root])).toEqual(expect.arrayContaining([omission, [{ s: 'muted', t: 'Search results truncated upstream' }], [{ s: 'muted', t: 'Search text clipped in view' }]]))
    expect(nodes(root).some(n => n.p?.['role'] === 'omp.tool.error')).toBe(true)
    expect(toolDetail(failed, 0).map(tree).flatMap(nodes).some(n => n.p?.['role'] === 'omp.tool.error')).toBe(true)
    const cancelled = call('search_files', {}, { result: { _omitted: 'filtered' }, outcome: { duration: 1, kind: 'cancelled' } })
    const stopped = tree(toolNode(cancelled, 0))
    expect(notices([stopped])).toContainEqual(omission)
    expect(notices([stopped]).some(n => JSON.stringify(n).includes('Interrupted'))).toBe(true)
  })
})
