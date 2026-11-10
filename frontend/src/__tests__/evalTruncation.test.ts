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
const notice = 'Hermes reports stdout was truncated'
const notices = (roots: NodeJson[]) => roots.flatMap(nodes).filter(n => n.p?.['role'] === 'omp.tool.notice').map(n => n.p?.['spans'])
const text = [{ s: 'muted', t: notice }]
const make = (result: unknown) => call('execute_code', { code: 'print(1)' }, { result })

describe('execute_code stdout truncation', () => {
  it('shows the pinned producer flag without echoing its warning or inventing recovered output', () => {
    const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/eval-truncation-core.py')], {
      cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
    })
    const data = parseJson(raw)
    if (!Array.isArray(data)) throw new Error('expected result array')
    const clipped = record(data[0])
    const short = record(data[1])
    expect(clipped).toMatchObject({ status: 'success', stdout_truncated: true, stdout_bytes_omitted: 32 })
    expect(short).toMatchObject({ status: 'success', output: 'ok', stdout_truncated: false })
    const c = make(clipped)
    const card = tree(toolNode(c, 0))
    const detail = toolDetail(c, 0).map(tree)
    expect(card.p).toMatchObject({ status: 'done', meta: [notice] })
    expect(notices([card])).toContainEqual(text)
    expect(notices(detail)).toContainEqual(text)
    expect(nodes(card).find(n => n.p?.['role'] === 'omp.tool.eval.output')?.p?.['text']).toBe(clipped?.['output'])
    expect(JSON.stringify(card)).not.toContain('Re-run only with narrower output')
    expect(notices([tree(toolNode(make(short), 0))])).not.toContainEqual(text)
    let n = 0
    const entries = history({ kept: [], id: p => entryId(`${p}${++n}`), messages: [
      { role: 'user', text: 'run' }, { role: 'tool', name: 'execute_code', tool_call_id: 'eval', args: { code: 'print(1)' }, content: JSON.stringify(clipped) }
    ] })
    const turn = entries.find(e => e.kind === 'turn')
    const block = turn?.blocks.find(b => b.kind === 'tool')
    if (block?.kind !== 'tool') throw new Error('missing replay call')
    expect(notices([tree(toolNode(block.call, 0))])).toContainEqual(text)
  })

  it('does not infer completeness from false, missing or malformed flags or expose arbitrary warnings', () => {
    for (const value of [undefined, false, 'true', 1, null, {}, []]) {
      const card = tree(toolNode(make({ stdout_truncated: value, output: 'partial', warning: 'private-warning' }), 0))
      expect(notices([card])).not.toContainEqual(text)
      expect(card.p?.['meta']).toBeUndefined()
      expect(JSON.stringify(card)).not.toContain('private-warning')
    }
    for (const extra of [{ stdout_bytes_omitted: 0 }, { stdout_bytes_omitted: '32' },
      { stdout_bytes_captured: -1 }, { stdout_bytes_total: 0 }, { stdout_bytes_total: 5, stdout_bytes_omitted: 6 },
      { stdout_bytes_captured: 50, stdout_bytes_total: 50 },
      { stdout_bytes_captured: 50, stdout_bytes_omitted: 2, stdout_bytes_total: 53 }]) {
      const contradictory = tree(toolNode(make({ stdout_truncated: true, output: 'partial', ...extra }), 0))
      expect(notices([contradictory])).not.toContainEqual(text)
    }
    const inherited = make(Object.assign(Object.create({ stdout_truncated: true }), { output: 'partial' }))
    expect(notices([tree(toolNode(inherited, 0))])).not.toContainEqual(text)
    expect(notices([tree(toolNode(make({ stdout_truncated: true, output: 'partial' }), 0))])).toContainEqual(text)
  })

  it('retains output and call status for errors, cancellations and running calls', () => {
    for (const outcome of [{ kind: 'error' as const, duration: 1 }, { kind: 'cancelled' as const, duration: 1 }, { kind: 'running' as const }]) {
      const c = call('execute_code', { code: 'code' }, { result: { stdout_truncated: true, output: 'partial', error: 'error detail' }, outcome })
      const card = tree(toolNode(c, 0))
      expect(card.p?.['status']).toBe(outcome.kind)
      expect(nodes(card).find(n => n.p?.['role'] === 'omp.tool.eval.output')?.p?.['text']).toBe('partial')
      expect(nodes(card).find(n => n.p?.['role'] === 'omp.tool.error')?.p?.['spans']).toEqual([{ s: 'error', t: 'error detail' }])
      if (outcome.kind === 'running') {
        expect(notices([card])).not.toContainEqual(text)
        expect(notices(toolDetail(c, 0).map(tree))).not.toContainEqual(text)
      } else {
        expect(notices([card])).toContainEqual(text)
        expect(notices(toolDetail(c, 0).map(tree))).toContainEqual(text)
      }
    }
  })
})
