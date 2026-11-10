import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { localCommand, type CommandHost } from '../commands/local.js'
import { entryId, liveSessionId, type SessionIds } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import { OverlayStack } from '../overlays/overlay.js'
import { retainedResults } from '../tool-results.js'
import { webExtractNeedsAttention } from '../tools/web-attention.js'
import { history } from '../transcript/history.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { foldOf, parts, pieces } from '../view/workLogModel.js'

import { key, must, stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

const extract = (result: unknown, more: Partial<ToolCall> = {}) => call('web_extract', {}, { result, ...more })
const tool = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: entryId(id), call: c })
const text = (id: string): Block => ({ kind: 'text', id: entryId(id), text: id })
const turn = (blocks: Block[]): TurnEntry => ({ kind: 'turn', id: entryId('turn'), rev: 0, startedAt: 0, end: { status: 'done', endedAt: 1000 }, blocks })
const cx: TranscriptContext = { copy: () => undefined, now: 1000, welcome: { version: '' } }
const nodes = (root: NodeJson): NodeJson[] => [root, ...(root.c ?? []).flatMap(nodes)]
const mixed = { results: [{ url: 'https://a.example', content: 'page', error: null }, { url: '', content: '', error: 'failed' }] }

describe('web extraction attention in work folds', () => {
  it('keeps a done call with an entry failure as a direct card between folded work and answer', () => {
    const fetch = tool('fetch', extract(mixed))
    const t = turn([tool('before', call('terminal')), fetch, tool('after', call('terminal')), text('answer')])
    expect(foldOf(t)?.hidden.has(fetch.id)).toBe(false)
    expect(parts(t).map(p => `${p.kind}:${p.blocks.map(b => b.id).join(',')}`)).toEqual(['fold:before', 'shown:fetch', 'fold:after', 'shown:answer'])
    expect(pieces([fetch], t.blocks)).toEqual([{ kind: 'block', block: fetch }])
    const root = tree(entryNode(t, 'main.test', cx))
    const cards = nodes(root).filter(n => n.k === 'tool' && n.p?.['name'] === 'fetch')
    expect(cards).toHaveLength(1)
    const card = cards[0]
    expect(card?.p).toMatchObject({ status: 'done', collapsed: false })
    expect(fetch.call.outcome.kind).toBe('done')
    if (!card) throw new Error('missing fetch card')
    const children = nodes(card)
    const page = children.findIndex(n => n.k === 'md' && n.p?.['text'] === 'page')
    const error = children.findIndex(n => n.p?.['role'] === 'omp.tool.error' && JSON.stringify(n.p?.['spans']).includes('Extraction failed: failed'))
    expect(page).toBeGreaterThan(-1)
    expect(error).toBeGreaterThan(page)
  })

  it('retains generic results and an ordinary failed work row around an unfolded Fetch', () => {
    const output = 'g'.repeat(4001)
    const before = tool('generic', call('custom_result', {}, { result: output }))
    const fetch = tool('fetch', extract(mixed))
    const failed = tool('failed', call('terminal', { command: 'false' }, { outcome: { duration: 1, kind: 'error', summary: 'failed command' } }))
    const t = turn([before, fetch, failed, text('answer')])
    expect(retainedResults([t]).map(result => result.text)).toEqual([output])
    const children = tree(entryNode(t, 'main.combined', cx)).c ?? []
    expect(children.map(n => n.p?.['role'])).toEqual(['hermes.turn.fold', undefined, 'hermes.work.row', undefined, 'omp.turn.usage'])
    expect(JSON.stringify(children[1])).toContain('Extraction failed: failed')
    expect(JSON.stringify(children[2])).toContain('failed command')
    expect(JSON.stringify(children[3])).toContain('answer')
  })

  it('keeps partial web failures visible while paging the exact retained pages and generic output', async () => {
    const generic = 'g'.repeat(4000) + 'GENERIC_TAIL'
    const success = 's'.repeat(4000) + 'SUCCESS_TAIL'
    const partial = 'p'.repeat(4000) + 'PARTIAL_TAIL\n[TRUNCATED: upstream middle omitted]'
    const rows = [{ content: success, url: 'https://a.example' }, { content: partial, error: 'failed', url: 'https://b.example' }]
    const before = tool('generic', call('custom_result', {}, { result: generic }))
    const fetch = tool('fetch', extract({ results: rows }))
    const t = turn([before, fetch, tool('after', call('terminal')), text('answer')])
    const root = tree(entryNode(t, 'main.retained', cx))
    const children = root.c ?? []
    expect(children.map(n => n.p?.['role'])).toEqual(['hermes.turn.fold', undefined, 'hermes.turn.fold', undefined, 'omp.turn.usage'])
    const card = nodes(root).find(n => n.k === 'tool' && n.p?.['name'] === 'fetch')
    expect(card?.p).toMatchObject({ status: 'done', collapsed: false })
    const cardNodes = nodes(must(card))
    expect(cardNodes.filter(n => n.p?.['role'] === 'omp.tool.error')).toHaveLength(1)
    expect(JSON.stringify(card)).toContain('Extraction failed: failed')
    expect(JSON.stringify(card)).toContain('/tool-results')
    expect(retainedResults([t]).map(result => result.text)).toEqual([generic, success, partial])

    const stack = new OverlayStack({ changed: vi.fn(), closed: vi.fn(), opened: vi.fn() })
    const session: { ref: SessionIds } = { ref: { live: liveSessionId('a'), stored: null } }
    const transcript = { entries: [t], lifetime: 0 }
    const draft = { text: 'draft preserved', cursor: 4 }
    const host = stub<CommandHost>({ session, transcript, composer: draft, get overlays() { return stack.items },
      changed: vi.fn(), open: stack.open.bind(stack), close: stack.close.bind(stack) })
    await must(localCommand('tool-results')).run(host, '')
    const sheet = must(stack.items.at(-1))
    const draw = () => JSON.stringify(tree(sheet.node(stack.rootOf(sheet))))
    expect(draw()).toContain('web_extract #1 · entry 2')
    expect(draw()).not.toContain('PARTIAL_TAIL')
    sheet.onKey(key('n'))
    expect(draw()).toContain('PARTIAL_TAIL')
    expect(draw()).toContain('upstream middle omitted')
    sheet.onKey(key('up'))
    expect(draw()).toContain('s'.repeat(4000))
    sheet.onKey(key('n'))
    expect(draw()).toContain('SUCCESS_TAIL')
    sheet.onKey(key('up'))
    sheet.onKey(key('n'))
    expect(draw()).toContain('GENERIC_TAIL')
    expect(draft).toEqual({ text: 'draft preserved', cursor: 4 })
    rows[0] = { content: success, url: 'https://a.example' }
    expect(draw()).not.toContain('web_extract #1 · entry 1')
    session.ref = { live: liveSessionId('b'), stored: null }
    expect(draw()).not.toContain('GENERIC_TAIL')
    expect(draw()).not.toContain('web_extract #1')
  })

  it('keeps a failure after an answer out of the fold without reordering', () => {
    const fetch = tool('fetch', extract(mixed))
    const t = turn([tool('before', call('terminal')), text('answer'), fetch])
    expect(foldOf(t)?.hidden.has(fetch.id)).toBe(false)
    expect(parts(t).flatMap(p => p.blocks.map(b => b.id))).toEqual(['before', 'answer', 'fetch'])
  })

  it('matches Fetch parsing while rejecting malformed and empty error fields', () => {
    const payloads = [undefined, null, {}, { results: 'bad' }, { results: [] },
      { results: [null, 7, 'error', ['x'], { error: null }, { error: '' }, { error: ' \n' }, { error: 1 }, { error: {} }] },
      { error: 'top-level only', results: [{ error: null }] }]
    for (const payload of payloads) expect(webExtractNeedsAttention(extract(payload))).toBe(false)
    expect(webExtractNeedsAttention(call('another_tool', {}, { result: mixed }))).toBe(false)
    expect(webExtractNeedsAttention(extract({ results: [{ error: 'failed' }] }))).toBe(true)
    expect(webExtractNeedsAttention(extract(JSON.stringify(mixed)))).toBe(true)
    expect(webExtractNeedsAttention(extract({ results: ['{"error":"legacy error"}'] }))).toBe(true)
    expect(webExtractNeedsAttention(extract({ results: [Object.create({ error: 'prototype' })] }))).toBe(true)
  })

  it('preserves #74 error/running handling and existing cancellation behavior', () => {
    for (const outcome of [{ kind: 'error' as const, duration: 1 }, { kind: 'running' as const }]) {
      const b = tool('fetch', extract(mixed, { outcome }))
      expect(webExtractNeedsAttention(b.call)).toBe(false)
      expect(foldOf(turn([b, text('answer')]))?.hidden.has(b.id)).not.toBe(true)
    }
    const cancelled = tool('cancelled', extract(mixed, { outcome: { kind: 'cancelled', duration: 1 } }))
    expect(webExtractNeedsAttention(cancelled.call)).toBe(false)
    expect(foldOf(turn([cancelled, text('answer')]))?.hidden.has(cancelled.id)).toBe(true)
    const clean = tool('clean', extract({ results: [{ url: 'https://a', content: 'ok', error: null }] }))
    expect(foldOf(turn([clean, text('answer')]))?.hidden.has(clean.id)).toBe(true)
  })

  it('preserves done and attention for a retained history result', () => {
    let n = 0
    const entries = history({ kept: [], id: p => entryId(`${p}${++n}`), messages: [
      { role: 'user', text: 'fetch' },
      { role: 'tool', name: 'web_extract', tool_call_id: 'f', args: {}, content: JSON.stringify(mixed) },
      { role: 'assistant', text: 'answer' }
    ] })
    const t = entries.find(e => e.kind === 'turn')
    if (!t) throw new Error('missing turn')
    const block = t.blocks.find(b => b.kind === 'tool')
    if (block?.kind !== 'tool') throw new Error('missing tool')
    expect(block.call.outcome.kind).toBe('done')
    expect(webExtractNeedsAttention(block.call)).toBe(true)
    expect(foldOf(t)?.hidden.has(block.id)).not.toBe(true)
    const card = nodes(tree(entryNode(t, 'main.replay', cx))).find(n => n.k === 'tool' && n.p?.['name'] === 'fetch')
    expect(card?.p?.['status']).toBe('done')
  })
})
