import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import { readConflictCount, readConflictNotice } from '../tools/read-conflicts.js'
import { history } from '../transcript/history.js'
import { Transcript } from '../transcript/store.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { parseJson, record } from '../wire/json.js'
import { stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const nodes = (n: NodeJson): NodeJson[] => [n, ...(n.c ?? []).flatMap(nodes)]
const make = (result: unknown) => call('read_file', { path: 'example.py' }, { result })

describe('read marker-pair disclosure', () => {
  it('shows the actual pinned producer count without trusting its stronger hint', () => {
    const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/read-conflict-core.py')], {
      cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
    })
    const payloads = parseJson(raw)
    if (!Array.isArray(payloads) || payloads.length !== 3) throw new Error('missing producer envelopes')
    for (const [i, value] of payloads.entries()) {
      const payload = record(value)
      if (!payload) throw new Error('missing producer envelope')
      expect(payload['is_error']).toBe(false)
      const result = record(payload['result'])
      if (!result) throw new Error('missing read result')
      if (i < 2) expect(result['conflict_blocks']).toBe(1)
      else expect(result['conflict_blocks']).toBeUndefined()
      const transcript = new Transcript()
      transcript.toolComplete(stub(payload), 5)
      const live = transcript.call(toolCallId(String(payload['tool_call_id'])))
      if (!live) throw new Error('missing read call')
      const root = tree(toolNode(live, 0))
      expect(root.p?.['status']).toBe('done')
      expect(readConflictCount(live)).toBe(i < 2 ? 1 : undefined)
      const view = JSON.stringify(root)
      const details = JSON.stringify(toolDetail(live, 0).map(tree))
      if (i < 2) {
        expect(root.p?.['collapsed']).toBe(false)
        expect(view).toContain(readConflictNotice(1))
        expect(details).toContain(readConflictNotice(1))
        expect(nodes(root).some(node => node.k === 'code')).toBe(true)
      } else expect(view).not.toContain('possible conflict marker')
      expect(view).not.toContain('unresolved git merge-conflict')
      expect(details).not.toContain('Resolve them')
    }
    const reverse = record(payloads[1])
    if (!reverse) throw new Error('missing reverse envelope')
    let n = 0
    const entries = history({ kept: [], id: p => entryId(`${p}${++n}`), messages: [
      { role: 'tool', name: 'read_file', tool_call_id: 'reverse', args: { path: 'example.py' }, content: String(reverse['result']) }
    ] })
    const turn = entries.find(e => e.kind === 'turn')
    const block = turn?.blocks.find(b => b.kind === 'tool')
    if (block?.kind !== 'tool') throw new Error('missing replay read')
    expect(JSON.stringify(tree(toolNode(block.call, 0)))).toContain(readConflictNotice(1))
  })

  it('accepts bounded counts with truncation and preserves the original notices', () => {
    const c = make({ content: '1|returned', conflict_blocks: 2, truncated: true, truncated_by: 'bytes', next_offset: 3, _hint: 'do not echo secret' })
    expect(readConflictCount(c)).toBe(2)
    const node = tree(toolNode(c, 0))
    const view = JSON.stringify(node)
    expect(view).toContain(readConflictNotice(2))
    expect(view).toContain('Hermes marked this read as truncated')
    expect(view).toContain('Hermes continuation offset: 3')
    expect(view).not.toContain('do not echo secret')
  })

  it('fails closed for contradictory, malformed, inherited and throwing inputs', () => {
    const valid = { content: '1|returned', conflict_blocks: 1 }
    for (const r of [
      {}, { conflict_blocks: 1 }, { ...valid, content: '' }, { ...valid, content: null },
      ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, true].map(conflict_blocks => ({ ...valid, conflict_blocks })),
      { ...valid, error: 'failed' }, { ...valid, success: false }, { ...valid, status: 'unchanged' },
      { ...valid, content_returned: false }, { ...valid, is_binary: true }, { ...valid, is_image: true }, { ...valid, not_found: true },
      Object.assign(Object.create({ conflict_blocks: 1 }), { content: '1|returned' }),
      { content: '1|returned', get conflict_blocks(): never { throw Error('bad') } },
      new Proxy({}, { getOwnPropertyDescriptor() { throw Error('bad') } })
    ]) expect(readConflictCount(make(r))).toBeUndefined()
    for (const outcome of [{ kind: 'running' as const }, { kind: 'cancelled' as const, duration: 1 }, { kind: 'error' as const, duration: 1 }]) {
      expect(readConflictCount(call('read_file', {}, { result: valid, outcome }))).toBeUndefined()
    }
    expect(readConflictCount(call('patch', {}, { result: valid }))).toBeUndefined()
  })
})
