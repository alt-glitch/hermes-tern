import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId } from '../core/ids.js'
import { history } from '../transcript/history.js'
import { Transcript } from '../transcript/store.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { parseJson, record } from '../wire/json.js'

import { must, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const notice = 'Hermes reports the execution environment was recreated; background processes and unpersisted files may be lost.'
const notices = (roots: NodeJson[]) => roots.flatMap(nodes).filter(n => n.p?.['role'] === 'omp.tool.notice').map(n => n.p?.['spans'])
const expected = [{ s: 'muted', t: notice }]

function fixture(): { flagged: Record<string, unknown>; clean: Record<string, unknown>; failed: Record<string, unknown>; cancelled: Record<string, unknown> } {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/terminal-recreated-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const results = parseJson(raw)
  if (!Array.isArray(results)) throw new Error('expected results')
  const flagged = record(results[0])
  const clean = record(results[1])
  const failed = record(results[2])
  const cancelled = record(results[3])
  if (!flagged || !clean || !failed || !cancelled) throw new Error('expected terminal objects')
  return { flagged, clean, failed, cancelled }
}

const make = (result: unknown) => call('terminal', { command: 'true' }, { result })

describe('terminal environment recreation', () => {
  it('discloses the exact pinned finalizer signal in card, grouped detail and retained replay', () => {
    const { flagged, clean } = fixture()
    expect(flagged).toMatchObject({ output: 'shown', exit_code: 0, error: null })
    expect(typeof flagged['environment_recreated']).toBe('string')
    expect(clean['environment_recreated']).toBeUndefined()
    const c = make(flagged)
    const card = tree(toolNode(c, 0))
    expect(card.p).toMatchObject({ status: 'done', collapsed: false, meta: ['Environment recreated; state may be lost'] })
    expect(notices([card])).toContainEqual(expected)
    expect(notices(toolDetail(c, 0).map(tree))).toContainEqual(expected)
    expect(nodes(card).find(n => n.k === 'ansi')?.p?.['text']).toBe('shown')
    expect(JSON.stringify(card)).not.toContain('Persistent files were restored')
    expect(notices([tree(toolNode(make(clean), 0))])).not.toContainEqual(expected)
    let n = 0
    const entries = history({ kept: [], id: p => entryId(`${p}${++n}`), messages: [
      { role: 'user', text: 'run' }, { role: 'tool', name: 'terminal', tool_call_id: 'term', args: { command: 'true' }, content: JSON.stringify(flagged) }
    ] })
    const turn = entries.find(e => e.kind === 'turn')
    const block = turn?.blocks.find(b => b.kind === 'tool')
    if (block?.kind !== 'tool') throw new Error('missing replay call')
    expect(notices([tree(toolNode(block.call, 0))])).toContainEqual(expected)
  })

  it('keeps actual nonzero and interrupted finalizer results through live transcript settlement', () => {
    const { failed, cancelled } = fixture()
    for (const [payload, kind, output] of [[failed, 'error', 'failure output'], [cancelled, 'cancelled', 'partial']] as const) {
      const transcript = new Transcript()
      transcript.messageStart()
      transcript.toolStart({ args: { command: 'true' }, name: 'terminal', tool_id: 'live' })
      transcript.toolComplete({ name: 'terminal', result: payload, tool_id: 'live' })
      const c = must(transcript.calls('terminal')[0])
      expect(c.outcome.kind).toBe(kind)
      const card = tree(toolNode(c, 0))
      expect(card.p).toMatchObject({ status: kind, collapsed: false })
      expect(nodes(card).find(n => n.k === 'ansi')?.p?.['text']).toBe(output)
      expect(notices([card])).toContainEqual(expected)
    }
  })

  it('rejects absent, malformed or contradictory signals and does not echo untrusted values', () => {
    const { flagged } = fixture()
    for (const result of [
      { ...flagged, environment_recreated: true }, { ...flagged, environment_recreated: 'private arbitrary string' },
      { ...flagged, environment_recreated: '' }, { ...flagged, output: 1 }, { ...flagged, exit_code: '0' },
      { ...flagged, exit_code: 1.5 }, { ...flagged, error: 'failed' }, { ...flagged, error: false },
      Object.assign(Object.create({ environment_recreated: flagged['environment_recreated'] }), { output: 'shown', exit_code: 0, error: null })
    ]) {
      const card = tree(toolNode(make(result), 0))
      expect(notices([card])).not.toContainEqual(expected)
      expect(JSON.stringify(card)).not.toContain('private arbitrary string')
    }
  })

  it('retains status and output for settled failures/cancellation, while running and background stay silent', () => {
    const { flagged } = fixture()
    for (const outcome of [{ kind: 'error' as const, duration: 1 }, { kind: 'cancelled' as const, duration: 1 }, { kind: 'running' as const }]) {
      const c = call('terminal', { command: 'true' }, { result: flagged, outcome })
      const card = tree(toolNode(c, 0))
      expect(card.p?.['status']).toBe(outcome.kind)
      expect(nodes(card).find(n => n.k === 'ansi')?.p?.['text']).toBe('shown')
      if (outcome.kind === 'running') expect(notices([card])).not.toContainEqual(expected)
      else {
        expect(notices([card])).toContainEqual(expected)
        expect(notices(toolDetail(c, 0).map(tree))).toContainEqual(expected)
      }
    }
    const background = call('terminal', { command: 'true', background: true }, { result: flagged })
    expect(notices([tree(toolNode(background, 0))])).not.toContainEqual(expected)
    const named = call('terminal', { command: 'true' }, { result: { ...flagged, session_id: 'pid' } })
    expect(notices([tree(toolNode(named, 0))])).not.toContainEqual(expected)
  })
})
