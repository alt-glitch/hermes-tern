import { describe, expect, it } from 'vitest'

import { liveSessionId } from '../core/ids.js'
import { busyFrom, routeEvent, Switches } from '../session/flow.js'

/** The shown session. */
const a = liveSessionId('a')

describe('Switches', () => {
  it('lets only the latest switch apply its result', () => {
    const s = new Switches()
    const first = s.begin()
    const second = s.begin()

    expect(s.current(first)).toBe(false)
    expect(s.current(second)).toBe(true)

    // The superseded switch finishing first leaves the newer one in flight.
    s.end(first)
    expect(s.pending).toBe(true)

    s.end(second)
    expect(s.pending).toBe(false)
  })

  it('hands out tickets that go stale once another switch begins', () => {
    const s = new Switches()
    const before = s.since()
    const token = s.begin()

    expect(before.isCurrent()).toBe(false)
    expect(before.signal.aborted).toBe(true)
    expect(s.generation).toBe(token)

    const during = s.since()
    s.end(token)
    // Ending a switch begins none: a ticket from during it stays current.
    expect(during.isCurrent()).toBe(true)
  })

  it('holds another session’s request only while a switch is in flight', () => {
    const s = new Switches()

    expect(s.route(a, 'a')).toBe('show')
    expect(s.route(a, undefined)).toBe('show')
    expect(s.route(null, undefined)).toBe('show')
    expect(s.route(a, 'b')).toBe('drop')
    // No session shown and no switch in flight: nothing will adopt it.
    expect(s.route(null, 'b')).toBe('drop')

    const token = s.begin()
    expect(s.route(a, 'b')).toBe('hold')
    expect(s.route(null, 'b')).toBe('hold')

    s.end(token)
    expect(s.route(a, 'b')).toBe('drop')
  })
})

describe('routeEvent', () => {
  it('keeps the active session’s events and drops other sessions’, in a switch too', () => {
    expect(routeEvent(a, false, { session_id: 'a', type: 'message.delta' })).toBe('show')
    expect(routeEvent(a, false, { session_id: 'b', type: 'message.delta' })).toBe('drop')
    expect(routeEvent(a, true, { session_id: 'b', type: 'message.delta' })).toBe('drop')
  })

  it('keeps global events', () => {
    expect(routeEvent(a, false, { type: 'skin.changed' })).toBe('show')
    expect(routeEvent(a, false, { session_id: 'b', type: 'gateway.ready' })).toBe('show')
    expect(routeEvent(null, false, { session_id: 'b', type: 'gateway.ready' })).toBe('show')
  })

  it('with no session shown, holds a session’s events while a switch is in flight and drops them otherwise', () => {
    expect(routeEvent(null, true, { session_id: 'b', type: 'message.start' })).toBe('hold')
    expect(routeEvent(null, false, { session_id: 'b', type: 'message.start' })).toBe('drop')
    expect(routeEvent(null, false, { type: 'skin.changed' })).toBe('show')
  })
})

describe('busyFrom', () => {
  it('is idle for a session at rest', () => {
    expect(busyFrom({ running: false, status: 'idle' })).toBeNull()
  })

  it('starts the working row at the running turn’s start', () => {
    expect(busyFrom({ running: true, turn_started_at: 100 }, 5)?.startedAt).toBe(100_000)
    expect(busyFrom({ status: 'waiting' }, 5)?.startedAt).toBe(5)
  })
})
