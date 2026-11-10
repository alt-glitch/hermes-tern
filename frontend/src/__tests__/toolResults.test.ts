import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'

import { Session, View } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { localCommand, type CommandHost } from '../commands/local.js'
import { entryId, liveSessionId, type SessionIds } from '../core/ids.js'
import type { Entry, ToolCall } from '../model.js'
import { openCommandPalette, type PaletteHost } from '../shortcuts/palette.js'
import { toolNode } from '../view/tools/shell.js'
import { OverlayStack } from '../overlays/overlay.js'
import { openToolResults, type ToolResultsHost } from '../overlays/toolResults.js'
import { history } from '../transcript/history.js'
import { RESULT_CANDIDATE_LIMIT, retainedGenericText, retainedResults, resultPage } from '../tool-results.js'
import { FakeGateway, key, must, stub, tree } from './fakes.js'
import { call } from './toolFixtures.js'

function entries(calls: ToolCall[]): Entry[] {
  return [{ kind: 'turn', id: entryId('turn'), rev: 0, end: { status: 'done' }, startedAt: 0,
    blocks: calls.map(item => ({ kind: 'tool', id: item.id, call: item })) }]
}

function harness(calls: ToolCall[]) {
  const stack = new OverlayStack({ changed: vi.fn(), closed: vi.fn(), opened: vi.fn() })
  const session: { ref: SessionIds } = { ref: { live: liveSessionId('a'), stored: null } }
  const transcript = { entries: entries(calls), lifetime: 0 }
  const host = stub<ToolResultsHost>({ session, transcript, get overlays() { return stack.items }, changed: vi.fn(),
    open: stack.open.bind(stack), close: stack.close.bind(stack) })
  const open = () => { openToolResults(host); return must(stack.items.at(-1)) }
  const draw = () => { const sheet = must(stack.items.at(-1)); return JSON.stringify(tree(sheet.node(stack.rootOf(sheet)))) }
  return { host, session, transcript, stack, open, draw }
}

const long = (name: string, text = 'x'.repeat(4001)) => call(name, {}, { result: text })

describe('retained generic results', () => {
  it('includes only retained long generic strings and bounds the candidate list', () => {
    expect(retainedGenericText(long('unknown', 'x'.repeat(4000)))).toBeUndefined()
    expect(retainedGenericText(long('web_extract'))).toBeUndefined()
    expect(retainedGenericText(call('unknown', {}, { result: { output: 'x'.repeat(5000) } }))).toBeUndefined()
    expect(retainedGenericText(call('unknown', {}, { result: 'x'.repeat(5000), outcome: { kind: 'running' } }))).toBeUndefined()
    expect(retainedGenericText(call('unknown', {}, { result: 'x'.repeat(5000), resultText: 'short' }))).toBeUndefined()
    const calls = Array.from({ length: 82 }, (_, i) => long(`custom_${i}`))
    const found = retainedResults(entries(calls))
    expect(found).toHaveLength(RESULT_CANDIDATE_LIMIT)
    expect(found[0]?.call).toBe(calls[2])
  })

  it('pages at grapheme boundaries, preserves text, and neutralizes controls', () => {
    const input = 'x'.repeat(3999) + '😀' + 'a\u0301' + 'tail'
    const first = must(resultPage(input, 0))
    const second = must(resultPage(input, first.end))
    expect(first.text.length).toBeLessThanOrEqual(4000)
    expect(first.text + second.text).toBe(input)
    expect(resultPage('x\x1b\u2028\u2029\u202e\u206a\u206f\ud800y', 0)?.text).toBe('x�������y')
    expect(resultPage('a' + '\u0301'.repeat(5000), 0)).toBeUndefined()
  })

  it('opens through the local command and pages without changing a draft', async () => {
    const h = harness([long('custom_result', 'a'.repeat(4000) + 'TAIL')])
    const draft = { text: 'draft survives' }
    expect(JSON.stringify(tree(toolNode(long('custom_result'), 0)))).toContain('/tool-results')
    await must(localCommand('tool-results')).run(stub<CommandHost>({ ...h.host, composer: draft }), '')
    const sheet = must(h.stack.items.at(-1))
    expect(h.draw()).toContain('Retained text may already be truncated upstream')
    expect(h.draw()).not.toContain('TAIL')
    sheet.onKey(key('n'))
    expect(h.draw()).toContain('TAIL')
    sheet.onKey(key('p'))
    expect(h.draw()).not.toContain('TAIL')
    expect(draft.text).toBe('draft survives')
  })

  it('hides session A metadata on A to B to A and remains dismissible', () => {
    const h = harness([long('secret_A')])
    const sheet = h.open()
    expect(h.draw()).toContain('secret_A')
    h.session.ref = { live: liveSessionId('b'), stored: null }
    expect(h.draw()).not.toContain('secret_A')
    h.session.ref = { live: liveSessionId('a'), stored: null }
    expect(h.draw()).not.toContain('secret_A')
    sheet.onKey(key('escape'))
    expect(h.stack.items).toHaveLength(0)
  })

  it('fails closed without a live owner and after transcript or call replacement', () => {
    const original = long('secret_A')
    const h = harness([original])
    h.session.ref = { live: null, stored: null }
    h.open()
    expect(h.draw()).toContain('A live session is required')
    expect(h.draw()).not.toContain('secret_A')
    h.session.ref = { live: liveSessionId('a'), stored: null }
    h.open()
    original.result = 'y'.repeat(4001)
    expect(h.draw()).not.toContain('secret_A')
    original.result = 'x'.repeat(4001)
    const turn = h.transcript.entries[0]
    if (turn?.kind === 'turn') { turn.rev++ }
    expect(h.draw()).not.toContain('secret_A')
    h.open()
    h.transcript.entries = entries([{ ...original }])
    expect(h.draw()).not.toContain('secret_A')
    h.transcript.lifetime++
    expect(h.draw()).not.toContain('secret_A')
  })

  it('skips a stale middle candidate during keyboard navigation', () => {
    const a = long('first_tool', 'a'.repeat(4001))
    const b = long('middle_tool', 'b'.repeat(4001))
    const c = long('last_tool', 'c'.repeat(4001))
    const h = harness([a, b, c])
    const sheet = h.open()
    b.result = 'changed'
    expect(h.draw()).not.toContain('middle_tool')
    sheet.onKey(key('up'))
    expect(h.draw()).toContain('a'.repeat(4000))
    sheet.onKey(key('down'))
    expect(h.draw()).toContain('c'.repeat(4000))
  })
})


describe('retained web extraction pages', () => {
  it('offers only long page contents in returned order and keeps page identity', () => {
    const web = call('web_extract', {}, { result: { results: [
      { content: 'a'.repeat(4001) }, null, { content: 4 }, { content: 'short' },
      { content: 'b'.repeat(4000) + 'TAIL', url: 'https://user:secret@example.invalid' }
    ] } })
    const h = harness([long('generic', 'g'.repeat(4001)), web])
    const found = retainedResults(h.transcript.entries)
    expect(found.map(r => r.web?.index)).toEqual([undefined, 0, 4])
    const encoded = call('web_extract', {}, { result: JSON.stringify({ results: [{ content: 's'.repeat(4001) }] }) })
    const encodedHost = harness([encoded])
    encodedHost.open()
    expect(encodedHost.draw()).toContain('s'.repeat(4000))
    const nested = call('web_extract', {}, { result: { results: [JSON.stringify({ content: 's'.repeat(4001) })] } })
    expect(retainedResults(entries([nested]))).toEqual([])
    expect(JSON.stringify(tree(toolNode(nested, 0)))).not.toContain('/tool-results')
    const sheet = h.open()
    expect(h.draw()).toContain('web_extract #1 · entry 5')
    expect(h.draw()).not.toContain('secret')
    expect(h.draw()).not.toContain('TAIL')
    sheet.onKey(key('n'))
    expect(h.draw()).toContain('TAIL')
    sheet.onKey(key('up'))
    expect(h.draw()).toContain('web_extract #1 · entry 1')
    expect(h.draw()).toContain('a'.repeat(4000))
    expect(h.draw()).not.toContain('TAIL')
  })

  it('distinguishes same-sized entries from different calls without showing URLs', () => {
    const first = call('web_extract', {}, { result: { results: [{ content: 'a'.repeat(4001), url: 'https://a:secret@example.invalid' }] } })
    const second = call('web_extract', {}, { result: { results: [{ content: 'b'.repeat(4001), url: 'https://b:secret@example.invalid' }] } })
    const h = harness([first, second])
    h.open()
    expect(h.draw()).toContain('web_extract #1 · entry 1')
    expect(h.draw()).toContain('web_extract #2 · entry 1')
    expect(h.draw()).not.toContain('secret')
  })

  it('exposes pinned returned truncation footer, without claiming full source recovery', () => {
    const payload = execFileSync('python3', [resolve('src/__tests__/fixtures/web-retained-core.py')], {
      cwd: resolve('.hermes-src'), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('.hermes-src') }
    })
    let n = 0
    const replay = history({ kept: [], id: p => entryId(`${p}${++n}`), messages: [
      { role: 'user', text: 'fetch' }, { role: 'tool', name: 'web_extract', tool_call_id: 'web', args: {}, content: payload }
    ] })
    const turn = replay.find(e => e.kind === 'turn')
    const block = turn?.blocks.find(b => b.kind === 'tool')
    if (block?.kind !== 'tool') throw new Error('missing web result')
    expect(typeof block.call.result).toBe('string')
    expect(JSON.stringify(tree(toolNode(block.call, 0)))).toContain('/tool-results')
    const h = harness([block.call])
    const sheet = h.open()
    expect(h.draw()).toContain('Retained text may already be truncated upstream')
    expect(h.draw()).not.toContain('Full text could not be stored')
    for (let page = 0; page < 4 && !h.draw().includes('Full text could not be stored'); page++) sheet.onKey(key('n'))
    expect(h.draw()).toContain('Full text could not be stored')
    expect(h.draw()).toContain('retained tail')
  })

  it('rejects replaced rows, changed content, call outcomes and session ABA', () => {
    const rows = [{ content: 'a'.repeat(4001) }, { content: 'b'.repeat(4001) }]
    const web = call('web_extract', {}, { result: { results: rows } })
    const h = harness([web])
    const sheet = h.open()
    expect(h.draw()).toContain('web_extract #1 · entry 2')
    rows[1] = { content: 'b'.repeat(4001) }
    expect(h.draw()).not.toContain('web_extract #1 · entry 2')
    sheet.onKey(key('up'))
    expect(h.draw()).toContain('a'.repeat(4000))
    must(rows[0]).content = 'c'.repeat(4001)
    expect(h.draw()).not.toContain('a'.repeat(4000))
    h.open()
    web.outcome = { duration: 1, kind: 'error' }
    expect(h.draw()).not.toContain('c'.repeat(4000))
    h.open()
    h.session.ref = { live: liveSessionId('b'), stored: null }
    h.session.ref = { live: liveSessionId('a'), stored: null }
    expect(h.draw()).not.toContain('c'.repeat(4000))
  })

  it('excludes running and malformed pages, bounding candidates across calls and entries', () => {
    const running = call('web_extract', {}, { result: { results: [{ content: 'x'.repeat(4001) }] }, outcome: { kind: 'running' } })
    const web = call('web_extract', {}, { result: { results: Array.from({ length: 90 }, (_, i) => ({ content: String(i).repeat(4001) })) } })
    expect(retainedResults(entries([running]))).toEqual([])
    const found = retainedResults(entries([web]))
    expect(found).toHaveLength(RESULT_CANDIDATE_LIMIT)
    expect(found[0]?.web?.index).toBe(10)
    expect(found.at(-1)?.web?.index).toBe(89)
  })
})

describe('retained result native event ownership', () => {
  it('rejects an old picker ID and callback after paging, and malformed item IDs', async () => {
    const h = harness([long('first_tool', 'a'.repeat(4001)), long('last_tool', 'c'.repeat(4001))])
    const sheet = h.open()
    const input = new EventEmitter()
    const tern = new Session(input, { write() {} }, { exitHooks: false, record: '' })
    const connecting = tern.handshake()
    input.emit('data', `\x1b_tsp;r;${JSON.stringify({ ...tern.caps, r: 'hello', v: 1, term: 'fixture', ver: '0' })}\x1b\\`)
    expect(await connecting).toBe(true)
    const surface = tern.open({ id: 'hermes', mode: 'inline', role: 'omp.session', title: 'Results' })
    try {
      const render = () => {
        const view = { layer: [sheet.node(h.stack.rootOf(sheet))], main: [] }
        surface.render(view)
        return View.from(view)
      }
      const old = render()
      const picker = must(old.find('layer.overlay-1.view-0'))
      expect(picker.node.kind).toBe('picker')
      const event = { ev: 'activate' as const, id: picker.id, item: '0', raw: {}, sf: 'hermes' }
      const oldCallback = must(surface.dispatch(event))
      sheet.onKey(key('n'))
      render()
      expect(surface.dispatch(event)).toBeUndefined()
      oldCallback()
      expect(h.draw()).toContain('Page 2')
      const current = must(surface.dispatch({ ...event, id: 'layer.overlay-1.view-1', item: '00' }))
      current()
      expect(h.draw()).toContain('Page 2')
      const valid = must(surface.dispatch({ ...event, id: 'layer.overlay-1.view-1' }))
      valid()
      expect(h.draw()).toContain('a'.repeat(4000))
    } finally {
      await tern.close()
    }
  })
})


describe('command palette entry', () => {
  it('routes a native pointer activation through the local command without editing the draft', async () => {
    const h = harness([long('custom_result')])
    const gateway = new FakeGateway({ replies: { 'commands.catalog': () => ({}) } })
    const run = vi.fn()
    const set = vi.fn()
    openCommandPalette(stub<PaletteHost>({ ...h.host, session: h.session, transcript: h.transcript, gw: gateway.client,
      composer: { set }, run, get overlays() { return h.stack.items } }))
    const sheet = must(h.stack.items.at(-1))
    const input = new EventEmitter()
    const tern = new Session(input, { write() {} }, { exitHooks: false, record: '' })
    const connecting = tern.handshake()
    input.emit('data', `\x1b_tsp;r;${JSON.stringify({ ...tern.caps, r: 'hello', v: 1, term: 'fixture', ver: '0' })}\x1b\\`)
    expect(await connecting).toBe(true)
    const surface = tern.open({ id: 'hermes', mode: 'inline', role: 'omp.session', title: 'Palette' })
    try {
      surface.render({ layer: [sheet.node('layer.command-palette')], main: [] })
      const activate = must(surface.dispatch({ ev: 'activate', id: 'layer.command-palette', item: '/tool-results', raw: {}, sf: 'hermes' }))
      activate()
      expect(run).toHaveBeenCalledWith('/tool-results')
      expect(set).not.toHaveBeenCalled()
    } finally {
      await tern.close()
    }
  })
})
