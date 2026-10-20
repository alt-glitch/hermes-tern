import { describe, expect, it } from 'vitest'

import { admissionId, inputId } from '../core/ids.js'
import { busyModeOf, type OwnAdmission, ServerQueue } from '../turn/serverQueue.js'
import type { PendingRow, PendingStatus } from '../wire/schemas.js'

const row = (id: string, status: PendingStatus, user = id, input = `in-${id}`): PendingRow => ({
  admission_id: admissionId(id),
  input_id: inputId(input),
  status,
  user
})

describe('ServerQueue', () => {
  it("shows a resumed session's queued rows, but owes no bubble for a row the snapshot already started", () => {
    const q = new ServerQueue<string>()
    q.reset([row('a', 'started'), row('b', 'queued'), row('c', 'unknown')])

    expect(q.queued().map(r => [r.kind, r.text])).toEqual([
      ['theirs', 'b'],
      ['theirs', 'c']
    ])
    expect(q.update([row('a', 'started'), row('b', 'queued'), row('c', 'unknown')])).toEqual([])
    expect(q.update([row('b', 'started'), row('c', 'unknown')])).toEqual([{ own: undefined, text: 'b' }])
  })

  it("lists an own admission before the FIFO does, then by the FIFO's row, and forgets it once it left without starting", () => {
    const q = new ServerQueue<string>()
    const own: OwnAdmission<string> = { admission: { kind: 'submitting' }, display: 'mine (typed)', inputId: inputId('in-x'), item: 'x' }
    q.admit(own)
    q.update([row('a', 'queued', 'theirs')])
    expect(q.queued()).toEqual([
      { kind: 'theirs', row: row('a', 'queued', 'theirs'), text: 'theirs' },
      { kind: 'sending', own, text: 'mine (typed)' }
    ])

    // Listed by the FIFO, in its place there, and named by prompt.submit's answer: it can be withdrawn.
    q.update([row('x', 'queued', 'mine (sent)'), row('a', 'queued', 'theirs')])
    q.admitted(own, admissionId('x'))
    expect(q.queued()).toEqual([
      { id: 'x', kind: 'mine', own, text: 'mine (typed)' },
      { kind: 'theirs', row: row('a', 'queued', 'theirs'), text: 'theirs' }
    ])

    // Cancelled from another window: the row is gone, and so is the own admission.
    q.update([row('a', 'queued', 'theirs')])
    expect(q.queued().map(r => r.kind)).toEqual(['theirs'])
    expect(own.admission).toEqual({ kind: 'withdrawn' })
  })

  it('moves an own admission submitting → admitted → started, and never back', () => {
    const q = new ServerQueue<string>()
    const own: OwnAdmission<string> = { admission: { kind: 'submitting' }, display: 'mine', inputId: inputId('in-x'), item: 'x' }
    q.admit(own)
    q.update([row('x', 'queued')])
    q.admitted(own, admissionId('x'))
    expect(own.admission).toEqual({ id: 'x', kind: 'admitted' })

    expect(q.update([row('x', 'started')])).toEqual([{ own, text: 'mine' }])
    expect(own.admission).toEqual({ kind: 'started' })

    // prompt.submit's answer after the start names nothing it could still withdraw.
    q.admitted(own, admissionId('x'))
    expect(own.admission).toEqual({ kind: 'started' })

    const gone: OwnAdmission<string> = { admission: { kind: 'submitting' }, display: 'gone', inputId: inputId('in-y'), item: 'y' }
    q.admit(gone)
    q.admitted(gone, admissionId('y'))
    q.withdrew(gone)
    expect(gone.admission).toEqual({ kind: 'withdrawn' })
    expect(q.queued()).toEqual([])
  })

  it('admits a submitting own admission the FIFO lists as queued, by the id the FIFO gives it', () => {
    const q = new ServerQueue<string>()
    const own: OwnAdmission<string> = { admission: { kind: 'submitting' }, display: 'mine', inputId: inputId('in-x'), item: 'x' }
    q.admit(own)
    q.update([row('x', 'unknown')])
    expect(own.admission).toEqual({ kind: 'submitting' })

    q.update([row('x', 'queued')])
    expect(own.admission).toEqual({ id: 'x', kind: 'admitted' })
    expect(q.queued()).toEqual([{ id: 'x', kind: 'mine', own, text: 'mine' }])
  })

  it('tells a withdrawn row’s cancelled completion from the running turn’s', () => {
    const q = new ServerQueue<string>()
    q.update([row('a', 'started'), row('b', 'queued')])

    expect(q.settlesQueuedRow({ admission_id: 'b', outcome: 'cancelled', text: '' })).toBe(true)
    expect(q.settlesQueuedRow({ admission_id: 'a', outcome: 'cancelled', text: '' })).toBe(false)
    expect(q.settlesQueuedRow({ text: 'done' })).toBe(false)
    // A completion with no fields this reads (or none at all) is the running turn's.
    expect(q.settlesQueuedRow({ admission_id: 7, outcome: 'cancelled' })).toBe(false)
    expect(q.settlesQueuedRow(undefined)).toBe(false)
    expect(q.settlesQueuedRow('cancelled')).toBe(false)

    // Withdrawn by this pane before the FIFO listed it as queued.
    q.withdrawn(admissionId('c'))
    expect(q.settlesQueuedRow({ admission_id: 'c', outcome: 'cancelled' })).toBe(true)
    expect(q.settlesQueuedRow({ admission_id: 'c', outcome: 'completed' })).toBe(false)
  })

  it('reads the busy mode, defaulting to queue', () => {
    expect(busyModeOf('steer')).toBe('steer')
    expect(busyModeOf(' Interrupt ')).toBe('interrupt')
    expect(busyModeOf('queue')).toBe('queue')
    expect(busyModeOf(undefined)).toBe('queue')
    expect(busyModeOf('bogus')).toBe('queue')
  })
})
