import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId } from '../core/ids.js'
import type { Block, TurnEntry } from '../model.js'
import { patchNoWriteReported } from '../tools/patch-noop.js'
import { history } from '../transcript/history.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { actionOf, foldOf, parts, stepLabel, summarize, type WorkItem } from '../view/workLogModel.js'
import { record } from '../wire/json.js'

import { tree } from './fakes.js'
import { call } from './toolFixtures.js'

const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const notice = (roots: NodeJson[]) => roots.flatMap(nodes).filter(n => n.p?.['role'] === 'omp.tool.notice').map(n => n.p?.['spans'])
const label = 'Target text appears present; no write performed'
const patch = (result: unknown) => call('patch', { path: 'file.py' }, { result })
const work = (c: ReturnType<typeof patch>): WorkItem => ({ kind: 'tool', id: c.id, call: c })

describe('already-applied patch projection', () => {
  it('renders the actual pinned producer and retained replay without a fabricated diff', () => {
    const raw = execFileSync('python3', [resolve('src/__tests__/fixtures/patch-noop-core.py')], {
      cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
    })
    const result = record(raw)
    expect(result).toMatchObject({ success: true, no_change: true })
    expect(result?.['note']).toContain('No write performed')
    const c = patch({ ...result, files_modified: ['/workspace/file.py'], resolved_path: '/workspace/file.py' })
    expect(patchNoWriteReported(c)).toBe(true)
    expect(stepLabel(c)).toBe('Patch target appears present in file.py')
    expect(actionOf(c)).toBe('other')
    const root = tree(toolNode(c, 0))
    expect(root.p).toMatchObject({ status: 'done', meta: [label] })
    expect(notice([root])).toContainEqual([{ s: 'muted', t: label }])
    expect(notice(toolDetail(c, 0).map(tree))).toContainEqual([{ s: 'muted', t: label }])
    expect(nodes(root).some(n => n.k === 'diff')).toBe(false)
    let n = 0
    const entries = history({ kept: [], id: p => entryId(`${p}${++n}`), messages: [
      { role: 'user', text: 'patch' }, { role: 'tool', name: 'patch', tool_call_id: 'p', args: { path: 'file.py' }, content: raw }
    ] })
    const turn = entries.find(e => e.kind === 'turn')
    const block = turn?.blocks.find(b => b.kind === 'tool')
    if (block?.kind !== 'tool') throw new Error('missing replay tool')
    expect(block.call.outcome.kind).toBe('done')
    expect(stepLabel(block.call)).toBe('Patch target appears present in file.py')
    expect(notice([tree(toolNode(block.call, 0))])).toContainEqual([{ s: 'muted', t: label }])
  })

  it('does not count validated no-op patches as changed files', () => {
    const noOp = patch({ success: true, no_change: true })
    const real = patch({ success: true, diff: '@@ -1 +1 @@\n-old\n+new' })
    expect(summarize([work(noOp)])).toBe('Used 1 tool')
    expect(summarize([work(noOp), work(real)])).toBe('Used 1 tool and changed 1 file')
    expect(stepLabel(real)).toBe('Edited file.py')
    expect(actionOf(real)).toBe('edit')
  })

  it('keeps the no-write notice in the actual folded turn and does not count it as a change', () => {
    const noOp = patch({ success: true, no_change: true })
    const real = call('patch', { path: 'other.py' }, { result: { success: true, diff: '@@ -1 +1 @@\n-old\n+new' } })
    const blocks: Block[] = [
      { kind: 'tool', id: entryId('no-op'), call: noOp },
      { kind: 'tool', id: entryId('real'), call: real },
      { kind: 'text', id: entryId('answer'), text: 'answer' }
    ]
    const turn: TurnEntry = { kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks }
    const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }
    const root = tree(entryNode(turn, 'main.patch', cx))
    const data = JSON.stringify(root)
    expect(data).toContain('hermes.turn.fold')
    expect(data).toContain('Used 1 tool and changed 1 file')
    expect(data).toContain('Patch target appears present in file.py')
    expect(data).toContain(label)
    expect(data).not.toContain('changed 2 files')
  })

  it('preserves web failure visibility and patch summaries in the combined turn', () => {
    const noOp = patch({ success: true, no_change: true })
    const web = call('web_extract', {}, { result: { results: [{ url: '', content: '', error: 'invalid URL' }] } })
    const real = call('patch', { path: 'other.py' }, { result: { success: true, diff: '@@ -1 +1 @@\n-old\n+new' } })
    const blocks: Block[] = [
      { kind: 'tool', id: entryId('no-op'), call: noOp },
      { kind: 'tool', id: entryId('web'), call: web },
      { kind: 'tool', id: entryId('real'), call: real },
      { kind: 'text', id: entryId('answer'), text: 'answer' }
    ]
    const turn: TurnEntry = { kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks }
    expect(foldOf(turn)?.hidden.has(entryId('web'))).toBe(false)
    expect(parts(turn).map(p => `${p.kind}:${p.blocks.map(b => b.id).join(',')}`)).toEqual(['fold:no-op', 'shown:web', 'fold:real', 'shown:answer'])
    const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }
    const root = tree(entryNode(turn, 'main.combined', cx))
    const fetch = nodes(root).filter(n => n.k === 'tool' && n.p?.['name'] === 'fetch')
    expect(fetch).toHaveLength(1)
    expect(fetch[0]?.p).toMatchObject({ status: 'done', collapsed: false })
    expect(JSON.stringify(fetch)).toContain('Extraction failed: invalid URL')
    expect(JSON.stringify(root)).toContain(label)
    expect(summarize([work(noOp), work(real)])).toBe('Used 1 tool and changed 1 file')
  })

  it('fails closed for contradictory, malformed, failed and cancelled payloads', () => {
    for (const result of [
      { no_change: true }, { success: 'true', no_change: true }, { success: true, no_change: 'true' },
      { success: true, no_change: true, error: 'denied' },
      { success: true, no_change: true, diff: '@@ -1 +1 @@\n-old\n+new' },
      { success: true, no_change: true, files_created: ['new'] },
      { success: true, no_change: true, files_deleted: ['old'] },
      { success: true, no_change: true, partial: true }, { success: true, no_change: true, truncated: true },
      { success: true, no_change: true, status: 'error' }, { success: true, no_change: true, ok: false },
      { success: true, no_change: true, exit_code: 1 }, { success: true, no_change: true, is_error: true },
      { success: true, no_change: true, failed: true }, { success: true, no_change: true, cancelled: true }
    ]) {
      const c = patch(result)
      expect(patchNoWriteReported(c)).toBe(false)
      expect(notice([tree(toolNode(c, 0))])).not.toContainEqual([{ s: 'muted', t: label }])
      if (result.no_change === true) {
        expect(stepLabel(c)).toBe('Patch file.py')
        expect(actionOf(c)).toBe('other')
      }
    }
    const inherited: unknown = Object.create({ success: true, no_change: true })
    const inheritedSuccess: unknown = Object.assign(Object.create({ success: true }), { no_change: true })
    expect(patchNoWriteReported(patch(inherited))).toBe(false)
    expect(patchNoWriteReported(patch(inheritedSuccess))).toBe(false)
    const staleDiff = call('patch', { path: 'file.py' }, { result: { success: true, no_change: true }, diff: '@@ -1 +1 @@\n-old\n+new' })
    const root = tree(toolNode(staleDiff, 0))
    expect(patchNoWriteReported(staleDiff)).toBe(false)
    expect(nodes(root).some(n => n.k === 'diff')).toBe(true)
    for (const outcome of [{ kind: 'error' as const, duration: 1 }, { kind: 'cancelled' as const, duration: 1 }, { kind: 'running' as const }]) {
      const c = call('patch', { path: 'file.py' }, { result: { success: true, no_change: true }, outcome })
      expect(patchNoWriteReported(c)).toBe(false)
      expect(stepLabel(c)).toBe('Patch file.py')
      expect(tree(toolNode(c, 0)).p?.['status']).toBe(outcome.kind)
    }
  })

  it('uses constant text rather than reflecting arbitrary notes and retains diagnostics', () => {
    const c = patch({ success: true, no_change: true, note: 'private\u001b[31mtext', lsp_diagnostics: 'diagnostic retained' })
    const root = tree(toolNode(c, 0))
    expect(JSON.stringify(root)).not.toContain('private')
    expect(JSON.stringify(root)).toContain('diagnostic retained')
    expect(notice([root])).toContainEqual([{ s: 'muted', t: label }])
  })
})
