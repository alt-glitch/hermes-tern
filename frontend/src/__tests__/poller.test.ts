import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Ticket } from '../core/epoch.js'
import { Poller } from '../core/poller.js'
import { errorCode } from '../core/errors.js'
import { attempt, settle } from '../core/result.js'

import { must } from './fakes.js'

/** A round that waits until the test lets it end. */
function gated() {
  const tickets: Ticket[] = []
  let release: () => void = () => undefined

  const run = vi.fn(async (ticket: Ticket) => {
    tickets.push(ticket)
    await new Promise<void>(resolve => (release = resolve))
  })

  return { end: () => release(), run, tickets }
}

describe('Poller', () => {
  afterEach(() => vi.useRealTimers())

  it('runs one round at a time, and pokes during a round run one more after it', async () => {
    const round = gated()
    const settled = vi.fn()
    const poller = new Poller({ cadence: () => 'off', run: round.run, settled })

    poller.poke()
    poller.poke()
    poller.poke()
    expect(round.run).toHaveBeenCalledTimes(1)
    expect(poller.running).toBe(true)

    round.end()
    await vi.waitFor(() => expect(round.run).toHaveBeenCalledTimes(2))
    round.end()
    await vi.waitFor(() => expect(poller.running).toBe(false))

    expect(round.run).toHaveBeenCalledTimes(2)
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('waits its cadence between rounds, and none while the cadence is off', async () => {
    vi.useFakeTimers()
    let ms: number | 'off' = 1000
    const run = vi.fn(async () => undefined)
    const poller = new Poller({ cadence: () => ms, run })

    poller.poke()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)

    ms = 'off'
    await vi.advanceTimersByTimeAsync(5000)
    expect(run).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(5000)
    expect(run).toHaveBeenCalledTimes(3)

    // A poke starts it again.
    poller.poke()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(4)
    poller.dispose()
  })

  it('makes the round in flight stale on adopt, and reruns for the new key after a poke', async () => {
    const round = gated()
    const poller = new Poller({ cadence: () => 'off', run: round.run })

    expect(poller.adopt('a')).toBe(true)
    poller.poke()
    const first = must(round.tickets[0])

    expect(poller.adopt('a')).toBe(false)
    expect(first.isCurrent()).toBe(true)

    expect(poller.adopt('b')).toBe(true)
    expect(first.isCurrent()).toBe(false)
    expect(first.signal.aborted).toBe(true)

    poller.poke()
    round.end()
    await vi.waitFor(() => expect(round.tickets).toHaveLength(2))
    expect(must(round.tickets[1]).isCurrent()).toBe(true)
    round.end()
  })

  it('counts as watched until each release runs, once', () => {
    const poller = new Poller({ cadence: () => 'off', run: async () => undefined })
    const one = poller.watch()
    const two = poller.watch()

    one()
    one()
    expect(poller.watched).toBe(true)
    two()
    expect(poller.watched).toBe(false)
  })

  it('stops for good on dispose: the round in flight goes stale and no poke runs', async () => {
    vi.useFakeTimers()
    const round = gated()
    const poller = new Poller({ cadence: () => 10, run: round.run })

    poller.poke()
    poller.dispose()
    expect(must(round.tickets[0]).isCurrent()).toBe(false)

    round.end()
    await vi.advanceTimersByTimeAsync(100)
    poller.poke()
    await vi.advanceTimersByTimeAsync(100)
    expect(round.run).toHaveBeenCalledTimes(1)
  })

  it('hands a failed round to onError and keeps its cadence', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const run = vi.fn(async () => {
      throw new Error('gateway gone')
    })
    const poller = new Poller({ cadence: () => 1000, onError, run })

    poller.poke()
    await vi.advanceTimersByTimeAsync(1000)

    expect(onError).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenNthCalledWith(1, new Error('gateway gone'))
    poller.dispose()
  })
})

describe('Result', () => {
  it('holds a value or what was thrown', async () => {
    expect(attempt(() => 1)).toEqual({ kind: 'ok', value: 1 })
    expect(
      attempt(() => {
        throw new Error('bad')
      })
    ).toEqual({ error: new Error('bad'), kind: 'failed' })
    expect(await settle(Promise.resolve('x'))).toEqual({ kind: 'ok', value: 'x' })
    expect(await settle(Promise.reject(new Error('no')))).toEqual({ error: new Error('no'), kind: 'failed' })
  })

  it("reads a system error's code", () => {
    expect(errorCode(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe('ENOENT')
    expect(errorCode(new Error('plain'))).toBeUndefined()
    expect(errorCode('ENOENT')).toBeUndefined()
  })
})
