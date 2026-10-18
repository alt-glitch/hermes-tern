import { describe, expect, it } from 'vitest'

import { busyModeOf, type PendingRow, ServerQueue } from '../serverQueue.js'

const row = (id: string, status: string, user = id, input = `in-${id}`): PendingRow => ({ admission_id: id, input_id: input, status, user })

describe('ServerQueue', () => {
  it("shows a resumed session's queued rows, but owes no bubble for a row the snapshot already started", () => {
    const q = new ServerQueue<string>()
    q.reset([row('a', 'started'), row('b', 'queued'), row('c', 'unknown')])

    expect(q.queued().map(r => r.text)).toEqual(['b', 'c'])
    expect(q.update([row('a', 'started'), row('b', 'queued'), row('c', 'unknown')])).toEqual([])
    expect(q.update([row('b', 'started'), row('c', 'unknown')])).toEqual([{ own: undefined, text: 'b' }])
  })

  it("lists an own admission before the FIFO does, then by the FIFO's row, and forgets it once it left without starting", () => {
    const q = new ServerQueue<string>()
    const own = { display: 'mine (typed)', inputId: 'in-x', item: 'x' }
    q.admit(own)
    expect(q.queued()).toEqual([{ own, text: 'mine (typed)' }])

    q.update([row('x', 'queued', 'mine (sent)')])
    expect(q.queued()).toEqual([{ own, row: row('x', 'queued', 'mine (sent)'), text: 'mine (typed)' }])

    // Cancelled from another window: the row is gone, and so is the own admission.
    q.update([])
    expect(q.queued()).toEqual([])
  })

  it('tells a withdrawn row’s cancelled completion from the running turn’s', () => {
    const q = new ServerQueue<string>()
    q.update([row('a', 'started'), row('b', 'queued')])

    expect(q.settlesQueuedRow({ admission_id: 'b', outcome: 'cancelled', text: '' })).toBe(true)
    expect(q.settlesQueuedRow({ admission_id: 'a', outcome: 'cancelled', text: '' })).toBe(false)
    expect(q.settlesQueuedRow({ text: 'done' })).toBe(false)
  })

  it('reads the busy mode, defaulting to queue', () => {
    expect(busyModeOf('steer')).toBe('steer')
    expect(busyModeOf(' Interrupt ')).toBe('interrupt')
    expect(busyModeOf('queue')).toBe('queue')
    expect(busyModeOf(undefined)).toBe('queue')
    expect(busyModeOf('bogus')).toBe('queue')
  })
})
