import { Node, type NodeJson } from '@stencil-hq/tern'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod/mini'

import type { PreviewRow, TranscriptReader } from '../hermes/sessionTranscript.js'
import type { Overlay } from '../overlays/overlay.js'

import { FakeGateway, key, must, stub, tree } from './fakes.js'
import { assignedRoot } from './overlayRoots.js'

const copied: string[] = []

vi.mock('../clipboard.js', () => ({ copyToClipboard: (text: string) => copied.push(text) }))

/** A `session.list` row with its picker fields. */
const row = (id: string, title: string, at: number) => ({
  cwd: '/w/app', id, last_active_at: at, message_count: 4, preview: `${title} prompt`, running: false,
  session_id: id, source: 'tui', started_at: at, title, workspace: '/w/app'
})

vi.mock('../hermes/sessionList.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../hermes/sessionList.js')>()),
  workspaceOf: () => Promise.resolve('/w/app')
}))

const { openSessionPicker } = await import('../overlays/sessions.js')

const user = (text: string): PreviewRow => ({ key: text, kind: 'user', steer: false, text })

function setup() {
  const reads: string[] = []
  const reader: TranscriptReader = {
    page: (id, cursor) => {
      reads.push(`page ${id} ${cursor ?? 'first'}`)

      return Promise.resolve(
        cursor === null ? { next: 'p5', reset: true, rows: [user('one'), user('two'), user('three')] } : { next: null, reset: false, rows: [user('four')] }
      )
    }
  }
  let overlay: Overlay | undefined
  const gateway = new FakeGateway({
    replies: {
      'session.resume': () => ({ revision: 3, execution_generation: 7 }),
      'session.mutate': () => ({ status: 'ok' }),
      // One live session and one from history; the stored scope also repeats the live one.
      'session.list': p =>
        p['scope'] === 'stored' ? { sessions: [row('b', 'Second', 100), row('a', 'First', 200)] } : { sessions: [row('a', 'First', 200)] }
    }
  })
  const host = {
    changed: vi.fn(),
    close: vi.fn(),
    gw: gateway.client,
    open: (o: Overlay) => {
      overlay = o
    },
    resume: vi.fn(() => Promise.resolve()),
    reveal: vi.fn(),
    scroll: vi.fn(),
    session: { info: null, ref: { live: null, stored: null } },
    transcript: { notice: vi.fn() }
  }

  openSessionPicker(stub(host), reader)

  const sheet = must(overlay, 'the picker')
  const root = assignedRoot(sheet)
  const draw = (): NodeJson => tree(sheet.node(root))
  const press = (name: string, mods = {}) => {
    sheet.onKey(key(name, mods))

    return draw()
  }

  return { draw, gateway, host, press, reads, sheet, root }
}

describe('the session picker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    copied.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists the live and the stored scope once each, newest activity first', async () => {
    const { draw, gateway } = setup()
    await vi.advanceTimersByTimeAsync(0)
    const items = draw().p?.['items']

    expect(gateway.sent('session.list')).toEqual([
      { limit: 200, picker: true, scope: 'live' },
      { limit: 200, picker: true, scope: 'stored' }
    ])
    expect(z.array(z.object({ id: z.string() })).parse(items).map(i => i.id)).toEqual(['a', 'b'])
  })

  it('reads the selected preview only once the selection rests, and keeps it', async () => {
    const { draw, press, reads } = setup()
    await vi.advanceTimersByTimeAsync(0)
    draw()

    await vi.advanceTimersByTimeAsync(150)
    press('down')
    await vi.advanceTimersByTimeAsync(150)
    press('up')
    await vi.advanceTimersByTimeAsync(199)

    expect(reads).toEqual([])

    await vi.advanceTimersByTimeAsync(1)

    expect(reads).toEqual(['page a first'])

    press('down')
    await vi.advanceTimersByTimeAsync(200)
    press('up')
    await vi.advanceTimersByTimeAsync(200)

    expect(reads).toEqual(['page a first', 'page b first'])
  })

  it('→ focuses the preview, ↓ steps through it, and stepping near the end reads the next page', async () => {
    const { draw, host, press, reads } = setup()
    await vi.advanceTimersByTimeAsync(0)
    draw()
    await vi.advanceTimersByTimeAsync(200)
    draw()

    expect(press('right').p?.['focus']).toBe('preview')
    expect(host.reveal).toHaveBeenLastCalledWith('layer.overlay-1.first')

    press('down')
    press('down')

    expect(host.reveal).toHaveBeenLastCalledWith('layer.overlay-1.m0')
    expect(reads).not.toContain('page a p5')

    press('down')

    expect(host.reveal).toHaveBeenLastCalledWith('layer.overlay-1.m1')
    expect(reads).toContain('page a p5')

    press('page_down')

    expect(host.scroll).toHaveBeenLastCalledWith('layer.overlay-1.m1', 'page-down')

    expect(press('left').p?.['focus']).toBe('list')
  })

  it('copies the whole id with ⌥C, and c in the preview', async () => {
    const { draw, press } = setup()
    await vi.advanceTimersByTimeAsync(0)
    draw()

    press('c', { alt: true })
    press('right')
    press('c')

    expect(copied).toEqual(['a', 'a'])
  })

  it('types into the search from the preview, and Escape steps back before it closes', async () => {
    const { draw, host, press } = setup()
    await vi.advanceTimersByTimeAsync(0)
    draw()
    await vi.advanceTimersByTimeAsync(200)
    draw()
    press('right')

    const typed = press('s', { text: 's' })

    expect(typed.p?.['query']).toBe('s')
    expect(typed.p?.['focus']).toBe('list')

    press('right')
    press('escape')

    expect(host.close).not.toHaveBeenCalled()

    press('escape')
    press('escape')

    expect(host.close).toHaveBeenCalled()
  })

  it.each(['y', 'enter'])('does not delete on modified %s, but honors bare confirmation once', async name => {
    const { draw, host, press } = setup()
    const request = vi.spyOn(host.gw, 'request')
    await vi.advanceTimersByTimeAsync(0)
    draw()
    press('backspace')
    for (const mods of [{ ctrl: true }, { alt: true }, { meta: true }, { shift: true }, { ctrl: true, alt: true }]) {
      press(name, mods)
      expect(draw().p?.['confirm']).toBeDefined()
    }
    expect(request.mock.calls.filter(([method]) => method === 'session.mutate')).toEqual([])
    press(name)
    press(name)
    await vi.advanceTimersByTimeAsync(0)
    expect(request.mock.calls.filter(([method]) => method === 'session.mutate')).toHaveLength(1)
    expect(request.mock.calls.find(([method]) => method === 'session.mutate')?.[1]).toMatchObject({
      session_id: 'a', operation: 'delete', expected_revision: 3, expected_generation: 7
    })
  })

  it('keeps confirmation on modified cancel and cancels with bare n', async () => {
    const { draw, host, press } = setup()
    const request = vi.spyOn(host.gw, 'request')
    await vi.advanceTimersByTimeAsync(0)
    draw()
    press('backspace')
    press('n', { ctrl: true, alt: true })
    expect(draw().p?.['confirm']).toBeDefined()
    press('n')
    expect(draw().p?.['confirm']).toBeUndefined()
    expect(request.mock.calls.filter(([method]) => method === 'session.mutate')).toEqual([])
  })

  it('preserves explicit native confirmation and deletes through the gateway once', async () => {
    const { draw, gateway, press, sheet, root } = setup()
    await vi.advanceTimersByTimeAsync(0)
    draw()
    press('backspace')
    const picker = sheet.node(root)
    if (!(picker instanceof Node)) { throw new Error('missing picker') }
    const click = must(picker.handlers?.onAction?.['confirm'])
    const event = { act: 'confirm', ev: 'action', id: root, raw: {}, sf: 'hermes' } as const
    click(event)
    click(event)
    await vi.advanceTimersByTimeAsync(0)
    expect(gateway.sent('session.resume')).toEqual([{ session_id: 'a' }])
    expect(gateway.sent('session.mutate')).toEqual([expect.objectContaining({
      session_id: 'a', operation: 'delete', expected_revision: 3, expected_generation: 7, payload: {}
    })])
    expect(gateway.sent('session.delete')).toEqual([])
    expect(z.array(z.object({ id: z.string() })).parse(draw().p?.['items']).map(i => i.id)).toEqual(['b'])
  })
})
