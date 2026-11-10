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
const notice = (roots: NodeJson[]) => roots.flatMap(nodes).filter(n => n.p?.['role'] === 'omp.tool.notice').map(n => n.p?.['spans'])
const err = (roots: NodeJson[]) => roots.flatMap(nodes).filter(n => n.p?.['role'] === 'omp.tool.error')
const text = (t: string) => [{ s: 'muted', t }]
const unchanged = 'Unchanged; Hermes did not return file content'
const truncated = 'Hermes marked this read as truncated'
const clipped = 'Some lines were clipped; their missing text may not be recoverable by offset'
const make = (result: unknown) => call('read_file', { path: 'file.py' }, { result })

describe('read status projection', () => {
  it('shows real pinned stub and budget metadata in standalone, grouped and retained replay', () => {
    const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/read-status-core.py')], {
      cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
    })
    const fixture = parseJson(raw)
    if (!Array.isArray(fixture)) throw new Error('expected read results')
    const [stub, page, clamp, ordinary, line] = fixture.map(record)
    expect(stub).toMatchObject({ status: 'unchanged', dedup: true, content_returned: false })
    expect(page).toMatchObject({ truncated: true, truncated_by: 'bytes', next_offset: 2 })
    expect(clamp).toMatchObject({ truncated: true, truncated_lines: true, next_offset: 2 })
    expect(ordinary).toMatchObject({ truncated: true })
    expect(line).toMatchObject({ truncated: false, truncated_lines: true })
    const expected = [[unchanged], [truncated, 'Hermes continuation offset: 2'],
      [truncated, clipped, 'Hermes continuation offset: 2'], [truncated], [clipped]]
    for (const [i, payload] of [stub, page, clamp, ordinary, line].entries()) {
      const c = make(payload)
      const root = tree(toolNode(c, 0))
      const detail = toolDetail(c, 0).map(tree)
      expect(root.p?.['status']).toBe('done')
      for (const label of expected[i] ?? []) {
        expect(notice([root])).toContainEqual(text(label))
        expect(notice(detail)).toContainEqual(text(label))
        expect(root.p?.['meta']).toContain(label)
      }
    }
    const lineRoot = tree(toolNode(make(line), 0))
    expect(lineRoot.p?.['meta']).toContain('1 lines')
    expect(notice([lineRoot])).not.toContainEqual(text(truncated))
    const content = nodes(tree(toolNode(make(page), 0))).find(n => n.k === 'code')?.p?.['text']
    expect(content).toBe('abc')
    let n = 0
    const entries = history({ kept: [], id: p => entryId(`${p}${++n}`), messages: [
      { role: 'user', text: 'read' },
      { role: 'tool', name: 'read_file', tool_call_id: 'prior', args: { path: 'file.py' }, content: JSON.stringify({ content: '1|old text', total_lines: 1 }) },
      { role: 'tool', name: 'read_file', tool_call_id: 'stub', args: { path: 'file.py' }, content: JSON.stringify(stub) },
      { role: 'tool', name: 'read_file', tool_call_id: 'clamp', args: { path: 'file.py' }, content: JSON.stringify(clamp) }
    ] })
    const turn = entries.find(e => e.kind === 'turn')
    const block = turn?.blocks.find(b => b.kind === 'tool' && b.call.id === 'stub')
    if (block?.kind !== 'tool') throw new Error('missing replay tool')
    const replay = tree(toolNode(block.call, 0))
    expect(notice([replay])).toContainEqual(text(unchanged))
    expect(JSON.stringify(replay)).not.toContain('old text')
    const clampedBlock = turn?.blocks.find(b => b.kind === 'tool' && b.call.id === 'clamp')
    if (clampedBlock?.kind !== 'tool') throw new Error('missing clamped replay tool')
    const clamped = tree(toolNode(clampedBlock.call, 0))
    expect(notice([clamped])).toEqual([text(truncated), text(clipped), text('Hermes continuation offset: 2')])
  })

  it('fails closed on malformed and conflicting stub or continuation fields', () => {
    const valid = { status: 'unchanged', dedup: true, content_returned: false }
    for (const result of [
      { ...valid, status: 'Unchanged' }, { ...valid, dedup: 1 }, { ...valid, content_returned: 'false' },
      { ...valid, content: '' }, { ...valid, content: null }, { ...valid, error: null }, { ...valid, error: 'failed' },
      { ...valid, truncated: true, truncated_by: 'bytes', next_offset: 2 }, { ...valid, truncated_lines: true },
      { ...valid, truncated: 'false' }, { ...valid, is_binary: true }, { ...valid, is_image: true },
      { ...valid, not_found: true }, { ...valid, base64_content: 'x' }, { ...valid, next_offset: null }
    ]) {
      const c = make(result)
      expect(notice([tree(toolNode(c, 0))])).not.toContainEqual(text(unchanged))
      expect(notice(toolDetail(c, 0).map(tree))).not.toContainEqual(text(unchanged))
    }
    const extra = make({ ...valid, path: 'file.py', message: 'unchanged', truncated: false, is_binary: false })
    expect(notice([tree(toolNode(extra, 0))])).toContainEqual(text(unchanged))
    for (const result of [
      { truncated: 'true', truncated_lines: 1, next_offset: 3, truncated_by: 'bytes' },
      { truncated: true, next_offset: -1, truncated_by: 'bytes' },
      { truncated: true, next_offset: 1.5, truncated_by: 'bytes' },
      { truncated: true, next_offset: 3, truncated_by: 'lines' }
    ]) expect(JSON.stringify(tree(toolNode(make(result), 0)))).not.toContain('continuation offset')
    const cancelled = call('read_file', { path: 'file.py' }, { result: valid, outcome: { duration: 1, kind: 'cancelled' } })
    expect(notice([tree(toolNode(cancelled, 0))])).not.toContainEqual(text(unchanged))
  })

  it('retains partial content and error/cancel status alongside notices', () => {
    const result = { content: '1|partial', truncated: true, truncated_lines: true, error: 'failed\u001b\u202e' }
    const failed = call('read_file', { path: 'file.py' }, { result, outcome: { duration: 1, kind: 'error' } })
    const root = tree(toolNode(failed, 0))
    expect(root.p?.['status']).toBe('error')
    expect(nodes(root).find(n => n.k === 'code')?.p?.['text']).toBe('partial')
    expect(err([root]).map(n => n.p?.['spans'])).toEqual([[{ s: 'error', t: 'failed\\u001b\\u202e' }]])
    expect(err(toolDetail(failed, 0).map(tree))).toHaveLength(1)
    expect(notice([root])).toContainEqual(text(clipped))
    const cancelled = call('read_file', { path: 'file.py' }, { result: { content: '1|part', truncated: true }, outcome: { duration: 1, kind: 'cancelled' } })
    const stopped = tree(toolNode(cancelled, 0))
    expect(notice([stopped])).toContainEqual(text(truncated))
    expect(notice([stopped]).some(n => JSON.stringify(n).includes('Interrupted'))).toBe(true)
  })
})
