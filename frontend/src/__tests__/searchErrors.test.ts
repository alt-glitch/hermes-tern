import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId } from '../core/ids.js'
import { history } from '../transcript/history.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'

import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const errors = (roots: NodeJson[]) => roots.flatMap(nodes).filter(n => n.p?.['role'] === 'omp.tool.error')
const notes = (roots: NodeJson[]) => roots.flatMap(nodes).filter(n => n.p?.['role'] === 'omp.tool.notice').map(n => n.p?.['spans'])
const scenarios = [
  { args: {}, result: { matches: [{ path: 'safe.py', line: 1, content: 'hit' }], error: 'search failed' }, content: 'hit' },
  { args: { target: 'files' }, result: { files: ['safe.py'], error: 'search failed' }, content: 'safe.py' },
  { args: {}, result: { matches_text: 'retained dense', error: 'search failed' }, content: 'retained dense' },
  { args: { output_mode: 'count' }, result: { counts: { 'safe.py': 2 }, error: 'search failed' }, content: 'safe.py' },
  { args: {}, result: { matches: [{ path: 'safe.py', line: 1, content: 'hit' }], _omitted: 'filtered', error: 'search failed' }, content: 'hit' }
]

describe('partial search failures', () => {
  it.each(scenarios)('retains one error beside partial output in card and grouped detail: $args', ({ args, result, content }) => {
    const c = call('search_files', args, { result, outcome: { duration: 1, kind: 'error' } })
    const root = tree(toolNode(c, 0))
    const detail = toolDetail(c, 0).map(tree)
    expect(root.p?.['status']).toBe('error')
    expect(JSON.stringify(root)).toContain(content)
    expect(JSON.stringify(detail)).toContain(content)
    expect(errors([root]).map(n => n.p?.['spans'])).toEqual([[{ s: 'error', t: 'search failed' }]])
    expect(errors(detail).map(n => n.p?.['spans'])).toEqual([[{ s: 'error', t: 'search failed' }]])
    expect(root.p?.['note']).toBeUndefined()
  })

  it('replays a retained structured failure without losing rows or duplicating the reason', () => {
    let n = 0
    const entries = history({ kept: [], id: p => entryId(`${p}${++n}`), messages: [
      { role: 'user', text: 'search' },
      { role: 'tool', name: 'search_files', tool_call_id: 's', args: {}, content: JSON.stringify(scenarios[0]?.result) }
    ] })
    const turn = entries.find(e => e.kind === 'turn')
    const block = turn?.blocks.find(b => b.kind === 'tool')
    if (block?.kind !== 'tool') throw new Error('missing replay tool')
    const root = tree(toolNode(block.call, 0))
    expect(root.p?.['status']).toBe('error')
    expect(JSON.stringify(root)).toContain('hit')
    expect(errors([root]).map(n => n.p?.['spans'])).toEqual([[{ s: 'error', t: 'search failed' }]])
  })

  it('handles empty, malformed, clipped and control-containing errors without inventing success', () => {
    const unsafe = 'x'.repeat(3999) + '😀\u001b[31m\u202e'
    const c = call('search_files', { target: 'files' }, { result: { files: ['safe'], error: unsafe }, outcome: { duration: 1, kind: 'error' } })
    const root = tree(toolNode(c, 0))
    expect(errors([root])[0]?.p?.['spans']).toEqual([{ s: 'error', t: 'x'.repeat(3999) }])
    expect(notes([root])).toContainEqual([{ s: 'muted', t: 'Search error text clipped in view' }])
    const control = call('search_files', { token: 'private-argument-marker' }, { result: { error: 'bad\u001b\u202e\u2028\u206a' }, outcome: { duration: 1, kind: 'error' } })
    const empty = tree(toolNode(control, 0))
    expect(errors([empty]).map(n => n.p?.['spans'])).toEqual([[{ s: 'error', t: 'bad\\u001b\\u202e\\u2028\\u206a' }]])
    expect(notes([empty])).toContainEqual([{ s: 'muted', t: 'Search error control characters escaped in view' }])
    expect(JSON.stringify(empty)).not.toContain('private-argument-marker')
    expect(empty.p?.['note']).toBeUndefined()
    const malformed = call('search_files', {}, { result: { error: 1 }, outcome: { duration: 1, kind: 'error' } })
    const malformedRoot = tree(toolNode(malformed, 0))
    expect(malformedRoot.p?.['status']).toBe('error')
    expect(errors([malformedRoot])).toHaveLength(0)
    const cancelled = call('search_files', {}, { result: { error: 'not a failure', matches_text: 'partial' }, outcome: { duration: 1, kind: 'cancelled' } })
    expect(errors([tree(toolNode(cancelled, 0))])).toHaveLength(0)
  })
})
