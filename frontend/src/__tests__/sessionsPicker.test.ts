import type { NodeJson } from '@stencil-hq/tern'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod/mini'

import type { PreviewRow, TranscriptReader } from '../hermes/sessionTranscript.js'
import type { Overlay } from '../overlays/overlay.js'

import { FakeGateway, key, must, type Reply, spanTexts, stub, tree } from './fakes.js'

const copied: string[] = []

vi.mock('../clipboard.js', () => ({ copyToClipboard: (text: string) => copied.push(text) }))

/** A `session.list` row with its picker fields. */
const row = (id: string, title: string, at: number, workspace = '/w/app') => ({
  cwd: workspace, id, last_active_at: at, message_count: 4, preview: `${title} prompt`, running: false,
  session_id: id, source: 'tui', started_at: at, title, workspace
})

/** One live session and one from history; the stored scope also repeats the live one. */
const twoSessions: Reply = p =>
  p['scope'] === 'stored' ? { next_cursor: null, sessions: [row('b', 'Second', 100), row('a', 'First', 200)] } : { sessions: [row('a', 'First', 200)] }

/** The ids of the items a picker draws, in order. */
const itemIds = (n: NodeJson) => z.array(z.object({ id: z.string() })).parse(n.p?.['items']).map(i => i.id)
/** The ids in a picker's order (its rows as listed, without the group headers). */
const orderIds = (n: NodeJson) => z.array(z.unknown()).parse(n.p?.['order']).filter(o => typeof o === 'string')
/** Each tab's count as drawn: the count, or the text the label adds while more rows remain. */
const tabCounts = (n: NodeJson) =>
  z
    .array(z.object({ count: z.optional(z.number()), id: z.string(), label: z.unknown() }))
    .parse(n.p?.['tabs'])
    .map(t => [t.id, t.count ?? spanTexts(t.label).at(-1)?.trim()])

vi.mock('../hermes/sessionList.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../hermes/sessionList.js')>()),
  workspaceOf: () => Promise.resolve('/w/app')
}))

const { openSessionPicker } = await import('../overlays/sessions.js')

const user = (text: string): PreviewRow => ({ key: text, kind: 'user', steer: false, text })

function setup(list: Reply = twoSessions) {
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
    replies: { 'session.list': list }
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
  const draw = (): NodeJson => tree(sheet.node('layer.sessions'))
  const press = (name: string, mods = {}) => {
    sheet.onKey(key(name, mods))

    return draw()
  }

  return { draw, gateway, host, press, reads, sheet }
}

describe('the session picker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    copied.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists the live and the stored scope once each, newest activity first, for the folder and for all', async () => {
    const { draw, gateway } = setup()
    await vi.advanceTimersByTimeAsync(0)

    expect(gateway.sent('session.list')).toEqual([
      { limit: 200, picker: true, scope: 'live', workspace: '/w/app' },
      { limit: 200, picker: true, scope: 'stored', workspace: '/w/app' },
      { limit: 200, picker: true, scope: 'live' },
      { limit: 200, picker: true, scope: 'stored' }
    ])
    expect(itemIds(draw())).toEqual(['a', 'b'])
    expect(tabCounts(draw())).toEqual([['here', 2], ['all', 2]])
  })

  it('reads the next page as the selection nears the end, and counts 200+ until the last one', async () => {
    const stored = Array.from({ length: 230 }, (_, n) => row(`s${String(n).padStart(3, '0')}`, `Chat ${n}`, 1000 - n, '/w/other'))
    const { draw, gateway, press } = setup(p => {
      if (p['scope'] === 'live' || p['workspace']) {
        return { next_cursor: null, sessions: [] }
      }

      return p['cursor'] === 'p2' ? { next_cursor: null, sessions: stored.slice(200) } : { next_cursor: 'p2', sessions: stored.slice(0, 200) }
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(draw().p?.['tab']).toBe('all')
    expect(tabCounts(draw())).toEqual([['here', 0], ['all', '200+']])

    press('page_down')

    expect(gateway.sent('session.list')).toHaveLength(4)

    const loading = press('end')

    expect(z.array(z.unknown()).parse(loading.p?.['order']).at(-1)).toEqual({ group: 'loading', label: 'Loading more…' })
    expect(gateway.sent('session.list').at(-1)).toEqual({ cursor: 'p2', limit: 200, picker: true, scope: 'stored' })

    await vi.advanceTimersByTimeAsync(0)

    expect(orderIds(draw())).toHaveLength(230)

    press('end')

    expect(draw().p?.['selected']).toBe('s229')
    expect(tabCounts(draw())).toEqual([['here', 0], ['all', 230]])
    expect(gateway.sent('session.list')).toHaveLength(5)
  })

  it('shows the folder tab the rows the gateway lists for the folder, however old', async () => {
    const { draw, gateway } = setup(p =>
      p['workspace'] === '/w/app'
        ? { next_cursor: null, sessions: p['scope'] === 'stored' ? [row('old', 'Old one', 5)] : [] }
        : { next_cursor: 'more', sessions: [row('new', 'New one', 900, '/w/other')] }
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(draw().p?.['tab']).toBe('here')
    expect(itemIds(draw())).toEqual(['old'])
    expect(gateway.sent('session.list').filter(p => p['workspace'] === '/w/app')).toHaveLength(2)
  })

  it('adds the stored matches the loaded rows lack once the text rests, once each', async () => {
    const { draw, gateway, press } = setup(p => {
      if (p['query']) {
        return { next_cursor: null, sessions: [row('a', 'First', 200), row('deep', 'Older match', 1)] }
      }

      return twoSessions(p)
    })
    await vi.advanceTimersByTimeAsync(0)
    draw()

    press('f', { text: 'f' })
    press('i', { text: 'i' })

    expect(orderIds(draw())).toEqual(['a'])

    await vi.advanceTimersByTimeAsync(250)

    expect(gateway.sent('session.list').at(-1)).toEqual({ limit: 200, picker: true, query: 'fi', scope: 'stored', workspace: '/w/app' })
    expect(orderIds(draw())).toEqual(['a', 'deep'])
    expect(itemIds(draw())).toEqual(['a', 'b', 'deep'])
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
    expect(host.reveal).toHaveBeenLastCalledWith('layer.sessions.first')

    press('down')
    press('down')

    expect(host.reveal).toHaveBeenLastCalledWith('layer.sessions.m0')
    expect(reads).not.toContain('page a p5')

    press('down')

    expect(host.reveal).toHaveBeenLastCalledWith('layer.sessions.m1')
    expect(reads).toContain('page a p5')

    press('page_down')

    expect(host.scroll).toHaveBeenLastCalledWith('layer.sessions.m1', 'page-down')

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
})
