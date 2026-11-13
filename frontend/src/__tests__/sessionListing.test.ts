// The session picker's lists read the stored sessions a page at a time (overlays/sessions/listing.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Listing, SEARCH_PAUSE, StoredSearch } from '../overlays/sessions/listing.js'

import { FakeGateway } from './fakes.js'

/** A `session.list` row; a higher `at` is newer. */
const row = (id: string, at: number, messages = 2) => ({
  id, last_active_at: at, message_count: messages, session_id: id, started_at: at, title: `Chat ${id}`
})

/** A gateway whose stored scope pages `stored` (newest first) `size` rows at a time; the cursor is the next row's index. */
function paging(stored: ReturnType<typeof row>[], size: number, live: ReturnType<typeof row>[] = []) {
  return new FakeGateway({
    replies: {
      'session.list': p => {
        if (p['scope'] === 'live') {
          return { scope: 'live', sessions: live }
        }

        const from = Number(p['cursor'] ?? 0)
        const to = from + size

        return { next_cursor: to < stored.length ? String(to) : null, scope: 'stored', sessions: stored.slice(from, to) }
      }
    }
  })
}

function listing(gateway: FakeGateway, filter = {}, live = true) {
  const changed = vi.fn()
  const list = new Listing({ changed, gw: gateway.client, keep: s => s.messages > 0 }, filter, live)

  return { changed, list }
}

const ids = (list: Listing) => list.rows.map(s => s.id)

describe('a picker listing', () => {
  it('follows the cursor to the end and holds each conversation once', async () => {
    const stored = Array.from({ length: 7 }, (_, n) => row(`s${n}`, 100 - n))
    // The open session is live and also stored; it lists once.
    const gateway = paging(stored, 3, [row('s0', 100)])
    const { changed, list } = listing(gateway)

    await list.read()

    expect(ids(list)).toEqual(['s0', 's1', 's2'])
    expect(list.exhausted).toBe(false)

    await list.read()
    await list.read()

    expect(ids(list)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6'])
    expect(list.exhausted).toBe(true)
    expect(changed).toHaveBeenCalledTimes(3)

    await list.read()

    expect(gateway.sent('session.list').map(p => [p['scope'], p['cursor']])).toEqual([
      ['live', undefined],
      ['stored', undefined],
      ['stored', '3'],
      ['stored', '6']
    ])
  })

  it('drops a row a later page repeats, and keeps no empty one', async () => {
    const gateway = new FakeGateway({
      replies: {
        'session.list': p =>
          p['cursor'] === 'two'
            ? { next_cursor: null, sessions: [row('a', 300), row('c', 100)] }
            : { next_cursor: 'two', sessions: [row('a', 200), row('b', 150), row('empty', 120, 0)] }
      }
    })
    const { list } = listing(gateway, {}, false)

    await list.read()
    await list.read()

    expect(ids(list)).toEqual(['a', 'b', 'c'])
    expect(list.rows[0]?.lastActive).toBe(200_000)
  })

  it('names its folder on every page, live and stored', async () => {
    const gateway = paging([row('a', 2), row('b', 1)], 1)
    const { list } = listing(gateway, { workspace: '/w/app' })

    await list.read()
    await list.read()

    expect(gateway.sent('session.list')).toEqual([
      { limit: 200, picker: true, scope: 'live', workspace: '/w/app' },
      { limit: 200, picker: true, scope: 'stored', workspace: '/w/app' },
      { cursor: '1', limit: 200, picker: true, scope: 'stored', workspace: '/w/app' }
    ])
  })

  it('keeps its rows when a page fails, and reads the same page on the next call', async () => {
    const gateway = paging([row('a', 2), row('b', 1)], 1)
    const { list } = listing(gateway, {}, false)
    await list.read()
    const handler = gateway.handlers.get('session.list')
    gateway.handlers.set('session.list', () => {
      throw new Error('socket closed')
    })

    await expect(list.read()).rejects.toThrow('socket closed')
    expect(ids(list)).toEqual(['a'])
    expect(list.loading).toBe(false)

    gateway.handlers.set('session.list', p => handler?.(p))
    await list.read()

    expect(ids(list)).toEqual(['a', 'b'])
    expect(gateway.sent('session.list').map(p => p['cursor'])).toEqual([undefined, '1', '1'])
  })
})

describe('the stored search', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks the gateway once the text rests, with the folder when one is named', async () => {
    const gateway = paging([row('needle', 1)], 200)
    const search = new StoredSearch({ changed: vi.fn(), gw: gateway.client, keep: () => true }, vi.fn())

    search.set('ne', '/w/app')
    await vi.advanceTimersByTimeAsync(SEARCH_PAUSE - 1)
    search.set(' needle ', '/w/app')
    await vi.advanceTimersByTimeAsync(SEARCH_PAUSE - 1)

    expect(gateway.sent('session.list')).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    search.set(' needle ', '/w/app')
    await vi.advanceTimersByTimeAsync(SEARCH_PAUSE)

    expect(gateway.sent('session.list')).toEqual([{ limit: 200, picker: true, query: 'needle', scope: 'stored', workspace: '/w/app' }])
    expect(search.listing?.rows.map(s => s.id)).toEqual(['needle'])
  })

  it('drops the reply for text the user has since changed', async () => {
    const replies: ((value: unknown) => void)[] = []
    const gateway = new FakeGateway({ replies: { 'session.list': () => new Promise(resolve => replies.push(resolve)) } })
    const changed = vi.fn()
    const search = new StoredSearch({ changed, gw: gateway.client, keep: () => true }, vi.fn())

    search.set('old', undefined)
    await vi.advanceTimersByTimeAsync(SEARCH_PAUSE)
    search.set('new', undefined)
    replies[0]?.({ next_cursor: null, sessions: [row('stale', 1)] })
    await vi.advanceTimersByTimeAsync(0)

    expect(search.listing).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(SEARCH_PAUSE)
    replies[1]?.({ next_cursor: null, sessions: [row('fresh', 1)] })
    await vi.advanceTimersByTimeAsync(0)

    expect(search.listing?.rows.map(s => s.id)).toEqual(['fresh'])
    expect(gateway.sent('session.list').map(p => p['query'])).toEqual(['old', 'new'])
  })

  it('sends nothing for blank text', async () => {
    const gateway = paging([], 200)
    const search = new StoredSearch({ changed: vi.fn(), gw: gateway.client, keep: () => true }, vi.fn())

    search.set('   ', undefined)
    await vi.advanceTimersByTimeAsync(SEARCH_PAUSE)

    expect(gateway.sent('session.list')).toEqual([])
  })
})
