import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { ToolCall } from '../model.js'
import { PATCH_CONTEXT_WARNING, patchContextWarning } from '../tools/patch-warning.js'
import { history } from '../transcript/history.js'
import { Transcript } from '../transcript/store.js'
import { entryNode } from '../view/transcript.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { parseJson, record } from '../wire/json.js'
import { stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const args = { mode: 'replace', path: 'x.py', old_string: 'before', new_string: 'after' }
const nodes = (node: NodeJson): NodeJson[] => [node, ...(node.c ?? []).flatMap(nodes)]
function fixture(): Record<string, unknown> {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/patch-context-core.py')], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const value = record(parseJson(raw))
  if (!value) throw new Error('missing envelope')
  return value
}
const make = (result: unknown, more: Partial<ToolCall> = {}) => call('patch', args, { result, outcome: { kind: 'done', duration: 1 }, ...more })

describe('patch context warning', () => {
  it('shows a fixed notice for the pinned producer without changing status or exposing backend context', () => {
    const payload = fixture()
    expect(payload['is_error']).toBe(false)
    expect(record(payload['result'])?.['_warning']).toContain('sibling subagent')
    const transcript = new Transcript()
    transcript.toolComplete(stub(payload), 5)
    const live = transcript.call(toolCallId('patch-warning'))
    if (!live) throw new Error('missing call')
    expect(patchContextWarning(live)).toBe(true)
    for (const hostLocal of [true, false]) {
      const card = tree(toolNode(live, 0, undefined, undefined, undefined, { cwd: '/repo', hostLocal, media: true }))
      expect(card.p).toMatchObject({ status: 'done', collapsed: false, target: 'x.py' })
      expect(card.p?.['href']).toBeUndefined()
      const view = JSON.stringify(card)
      expect(view.split(PATCH_CONTEXT_WARNING)).toHaveLength(2)
      expect(view).not.toContain('/backend/private')
      expect(view).not.toContain('sibling-secret')
      expect(nodes(card).some(node => node.k === 'diff')).toBe(true)
    }
    expect(JSON.stringify(toolDetail(live, 0).map(tree)).split(PATCH_CONTEXT_WARNING)).toHaveLength(2)
  })

  it('retains a fixed notice on replay if the result is retained', () => {
    const payload = fixture()
    let n = 0
    const entries = history({ kept: [], id: p => entryId(`${p}${++n}`), messages: [
      { role: 'tool', name: 'patch', tool_call_id: 'patch-warning', args, content: String(payload['result']) },
      { role: 'assistant', text: 'answer' }
    ] })
    const turn = entries.find(e => e.kind === 'turn')
    if (!turn || turn.kind !== 'turn') throw new Error('missing turn')
    const view = JSON.stringify(tree(entryNode(turn, 'main.replay', { copy: () => undefined, now: 1000, welcome: { version: '' } })))
    expect(view).toContain(PATCH_CONTEXT_WARNING)
    expect(view).not.toContain('sibling-secret')
  })

  it('handles settled errors and missing diffs without asserting patch outcome', () => {
    for (const outcome of [{ kind: 'done' as const, duration: 1 }, { kind: 'error' as const, duration: 1 }]) {
      const c = make({ _warning: 'secret', error: 'failed' }, { outcome })
      const card = tree(toolNode(c, 0))
      expect(patchContextWarning(c)).toBe(true)
      expect(card.p?.['status']).toBe(outcome.kind)
      expect(card.p?.['collapsed']).toBe(false)
      expect(JSON.stringify(card)).toContain(PATCH_CONTEXT_WARNING)
      expect(JSON.stringify(card)).not.toContain('secret')
      if (outcome.kind === 'error') {
        expect(JSON.stringify(card)).toContain('failed')
        expect(JSON.stringify(toolDetail(c, 0).map(tree))).toContain('failed')
      }
    }
  })

  it('requires an own nonblank text warning and a settled patch', () => {
    for (const result of [{}, { _warning: '' }, { _warning: ' \n' }, { _warning: null }, { _warning: 1 }, { _warning: [] }, Object.create({ _warning: 'inherited' })]) {
      expect(patchContextWarning(make(result))).toBe(false)
    }
    for (const outcome of [{ kind: 'running' as const }, { kind: 'cancelled' as const, duration: 1 }]) {
      expect(patchContextWarning(make({ _warning: 'x' }, { outcome }))).toBe(false)
    }
    expect(patchContextWarning(call('write_file', args, { result: { _warning: 'x' }, outcome: { kind: 'done', duration: 1 } }))).toBe(false)
  })

  it('keeps arbitrary warning text and backend context out of the card', () => {
    const c = make({ _warning: 'SECRET\u001b\u202e' + 'x'.repeat(10000), resolved_path: '/private/secret' }, { args: { mode: 'patch', patch: 'patch body' }, context: '/private/context' })
    const view = JSON.stringify(tree(toolNode(c, 0, undefined, undefined, undefined, { cwd: '/repo', hostLocal: true, media: true })))
    expect(view).toContain(PATCH_CONTEXT_WARNING)
    expect(view).not.toContain('SECRET')
    expect(view).not.toContain('/private/')
  })
})
