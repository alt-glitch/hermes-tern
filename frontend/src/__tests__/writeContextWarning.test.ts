import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { ToolCall } from '../model.js'
import { PATCH_CONTEXT_WARNING, patchContextWarning, WRITE_CONTEXT_WARNING, writeContextWarning } from '../tools/patch-warning.js'
import { history } from '../transcript/history.js'
import { Transcript } from '../transcript/store.js'
import { entryNode } from '../view/transcript.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { parseJson, record } from '../wire/json.js'
import { stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const args = { path: 'x.py', content: 'proposed content' }
const nodes = (node: NodeJson): NodeJson[] => [node, ...(node.c ?? []).flatMap(nodes)]
function fixture(name: string, mode?: string): Record<string, unknown> {
  const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/' + name), ...(mode ? [mode] : [])], {
    cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
  })
  const value = record(parseJson(raw))
  if (!value) throw new Error('missing envelope')
  return value
}
const make = (result: unknown, more: Partial<ToolCall> = {}) => call('write_file', args, { result, outcome: { kind: 'done', duration: 1 }, ...more })

describe('write context warning', () => {
  for (const mode of ['success', 'error']) {
    it(`discloses the pinned ${mode} producer without changing outcome or exposing backend context`, () => {
      const payload = fixture('write-context-core.py', mode)
      expect(payload['is_error']).toBe(mode === 'error')
      expect(record(payload['result'])?.['_warning']).toContain('OUTSIDE the active workspace')
      const transcript = new Transcript()
      transcript.toolComplete(stub(payload), 5)
      const live = transcript.call(toolCallId('write-warning'))
      if (!live) throw new Error('missing call')
      expect(writeContextWarning(live)).toBe(true)
      expect(patchContextWarning(live)).toBe(false)
      for (const hostLocal of [true, false]) {
        const card = tree(toolNode(live, 0, undefined, undefined, undefined, { cwd: '/repo', hostLocal, media: true }))
        expect(card.p).toMatchObject({ status: mode === 'error' ? 'error' : 'done', collapsed: false, target: 'x.py' })
        expect(card.p?.['href']).toBeUndefined()
        const view = JSON.stringify(card)
        expect(view.split(WRITE_CONTEXT_WARNING)).toHaveLength(2)
        expect(view).not.toContain('/backend/private')
        expect(view).not.toContain('/synthetic/workspace')
        expect(nodes(card).find(node => node.k === 'code')?.p?.['text']).toBe(args.content)
        if (mode === 'error') {
          expect(view).toContain('Candidate content; Hermes reported a write error')
          expect(view).not.toContain('Synthetic write failure')
        }
      }
      expect(JSON.stringify(toolDetail(live, 0).map(tree)).split(WRITE_CONTEXT_WARNING)).toHaveLength(2)
    })
  }

  it('retains the notice in replay when the producer result survives', () => {
    const payload = fixture('write-context-core.py', 'success')
    let n = 0
    const entries = history({ kept: [], id: p => entryId(`${p}${++n}`), messages: [
      { role: 'tool', name: 'write_file', tool_call_id: 'write-warning', args, content: String(payload['result']) },
      { role: 'assistant', text: 'answer' }
    ] })
    const turn = entries.find(e => e.kind === 'turn')
    if (!turn || turn.kind !== 'turn') throw new Error('missing turn')
    const view = JSON.stringify(tree(entryNode(turn, 'main.replay', { copy: () => undefined, now: 1000, welcome: { version: '' } })))
    expect(view).toContain(WRITE_CONTEXT_WARNING)
    expect(view).not.toContain('/synthetic/workspace')
  })

  it('preserves validated write refusal and lint disclosures alongside the warning', () => {
    const payload = fixture('write-refusal-core.py')
    const result = record(payload['result'])
    const refusalArgs = record(payload['args'])
    if (!result || !refusalArgs) throw new Error('missing refusal fixture')
    const refusal = call('write_file', refusalArgs, { result: { ...result, _warning: 'secret' }, outcome: { kind: 'error', duration: 1 } })
    const card = JSON.stringify(tree(toolNode(refusal, 0)))
    expect(card).toContain(WRITE_CONTEXT_WARNING)
    expect(card).toContain('Candidate content; write refused')
    expect(card).toContain('NOT created or modified')
    expect(card).not.toContain('secret')
    if (typeof result['error'] !== 'string') throw new Error('missing refusal error')
    const privateRefusal = call('write_file', refusalArgs, { result: { ...result, error: result['error'].replace('x.json', '/backend/private/x.json'), resolved_path: '/backend/private/x.json', _warning: 'secret' }, outcome: { kind: 'error', duration: 1 } })
    for (const hostLocal of [true, false]) {
      const view = JSON.stringify(tree(toolNode(privateRefusal, 0, undefined, undefined, undefined, { cwd: '/repo', hostLocal, media: true })))
      expect(view).toContain('NOT created or modified')
      expect(view).toContain(WRITE_CONTEXT_WARNING)
      expect(view).not.toContain('/backend/private')
    }
    const lint = make({ _warning: 'secret', lint: { status: 'error', output: 'syntax failure' } })
    const lintCard = JSON.stringify(tree(toolNode(lint, 0)))
    expect(lintCard).toContain(WRITE_CONTEXT_WARNING)
    expect(lintCard).toContain('Lint reported an error')
    expect(lintCard).toContain('syntax failure')
  })

  it('retains a safe error notice when a warning adds the only card row', () => {
    const c = make({ _warning: 'secret', error: 'write failed: /backend/private', resolved_path: '/backend/private' }, { args: { path: 'x.py', content: '' }, outcome: { kind: 'error', duration: 1 } })
    for (const hostLocal of [true, false]) {
      const links = { cwd: '/repo', hostLocal, media: true }
      const view = JSON.stringify(tree(toolNode(c, 0, undefined, undefined, undefined, links)))
      expect(view).toContain('Hermes reported a write error')
      expect(view).not.toContain('/backend/private')
      expect(JSON.stringify(toolDetail(c, 0, undefined, undefined, undefined, links).map(tree))).not.toContain('/backend/private')
    }
  })

  it('does not present a failed candidate as a new file when a diff is retained', () => {
    const c = make({ _warning: 'context', diff: '@@ -0,0 +1 @@\n+candidate' }, { outcome: { kind: 'error', duration: 1 } })
    const view = JSON.stringify(tree(toolNode(c, 0)))
    expect(view).toContain('Candidate content; Hermes reported a write error')
    expect(view).not.toContain('new file')
    const retained = make({ _warning: 'context', diff: '@@ -1 +1 @@\n-before\n+after' }, { outcome: { kind: 'error', duration: 1 } })
    expect(JSON.stringify(tree(toolNode(retained, 0)))).toContain('Retained diff; Hermes reported a write error')
  })

  it('requires an own nonblank warning and settled write, failing closed on uninspectable data', () => {
    for (const result of [{}, { _warning: '' }, { _warning: ' \n' }, { _warning: null }, { _warning: 1 }, { _warning: [] }, Object.create({ _warning: 'inherited' }), { get _warning(): never { throw Error('no') } }, new Proxy({}, { getOwnPropertyDescriptor() { throw Error('no') } })]) {
      expect(writeContextWarning(make(result))).toBe(false)
    }
    for (const outcome of [{ kind: 'running' as const }, { kind: 'cancelled' as const, duration: 1 }]) {
      expect(writeContextWarning(make({ _warning: 'x' }, { outcome }))).toBe(false)
    }
    expect(writeContextWarning(call('patch', args, { result: { _warning: 'x' }, outcome: { kind: 'done', duration: 1 } }))).toBe(false)
    expect(PATCH_CONTEXT_WARNING).not.toBe(WRITE_CONTEXT_WARNING)
  })

  it('does not render arbitrary warning text or fallback backend context', () => {
    const c = make({ _warning: 'SECRET\u001b\u202e' + 'x'.repeat(10000), resolved_path: '/private/secret' }, { args: { content: 'candidate' }, context: '/private/context' })
    const view = JSON.stringify(tree(toolNode(c, 0, undefined, undefined, undefined, { cwd: '/repo', hostLocal: true, media: true })))
    expect(view).toContain(WRITE_CONTEXT_WARNING)
    expect(view).not.toContain('SECRET')
    expect(view).not.toContain('/private/')
  })
})
