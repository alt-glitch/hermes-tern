import { describe, expect, it } from 'vitest'

import { busyFrom, ownsEvent, Switches } from '../flow.js'

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

  it('holds another session’s request only while a switch is in flight', () => {
    const s = new Switches()

    expect(s.route('a', 'a')).toBe('show')
    expect(s.route('a', undefined)).toBe('show')
    expect(s.route(null, 'b')).toBe('show')
    expect(s.route('a', 'b')).toBe('drop')

    const token = s.begin()
    expect(s.route('a', 'b')).toBe('hold')

    s.end(token)
    expect(s.route('a', 'b')).toBe('drop')
  })
})

describe('ownsEvent', () => {
  it('keeps the active session’s events and drops other sessions’', () => {
    expect(ownsEvent('a', { session_id: 'a', type: 'message.delta' })).toBe(true)
    expect(ownsEvent('a', { session_id: 'b', type: 'message.delta' })).toBe(false)
  })

  it('keeps global events', () => {
    expect(ownsEvent('a', { type: 'skin.changed' })).toBe(true)
    expect(ownsEvent('a', { session_id: 'b', type: 'gateway.ready' })).toBe(true)
  })

  it('keeps everything before a session is adopted', () => {
    expect(ownsEvent(null, { session_id: 'b', type: 'message.start' })).toBe(true)
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
