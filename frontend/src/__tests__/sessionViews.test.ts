// SessionViews owns this pane's subscriptions: adopting ids, leaving via the gateway, serialising detach for one session, and releasing superseded switches.
// Exercise it with the in-process gateway only; no App, network, or user profile.
import { describe, expect, it } from 'vitest'

import { liveSessionId, storedSessionId } from '../core/ids.js'
import { SessionViews } from '../session/views.js'

import { FakeGateway } from './fakes.js'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const snapshot = { session_id: 's1', stored_session_id: 'db1', subscription_id: 'sub1' }

describe('SessionViews', () => {
  it('adopt_ids', () => {
    const views = new SessionViews(new FakeGateway().client)

    expect(views.adopt(snapshot)).toEqual({ live: 's1', stored: 'db1' })
  })

  it('adopt_ids_infoWins', () => {
    const views = new SessionViews(new FakeGateway().client)

    expect(views.adopt({ ...snapshot, info: { stored_session_id: 'from-info' }, stored_session_id: 'from-top' })).toEqual({
      live: 's1',
      stored: 'from-info'
    })
    expect(views.adopt({ ...snapshot, info: { stored_session_id: '' }, session_id: 's2', stored_session_id: 'from-top' })).toEqual({
      live: 's2',
      stored: 'from-top'
    })
  })

  it('adopt_ids_emptyStored', () => {
    const views = new SessionViews(new FakeGateway().client)

    expect(views.adopt({ session_id: 's1', stored_session_id: '' })).toEqual({ live: 's1', stored: null })
  })

  it('leave_canonical', async () => {
    const gw = new FakeGateway()
    const views = new SessionViews(gw.client)
    views.adopt(snapshot)

    await views.leave(liveSessionId('s1'), 'tui_close')

    expect(gw.sent('session.detach')).toEqual([{ end_reason: 'tui_close', session_id: 's1', subscription_id: 'sub1' }])
    expect(gw.sent('session.close')).toEqual([])
  })

  it('leave_canonical_secondLeaveDoesNotDetachAgain', async () => {
    const gw = new FakeGateway()
    const views = new SessionViews(gw.client)
    views.adopt(snapshot)

    await views.leave(liveSessionId('s1'), 'tui_close')
    await views.leave(liveSessionId('s1'), 'tui_close')

    expect(gw.sent('session.detach')).toEqual([{ end_reason: 'tui_close', session_id: 's1', subscription_id: 'sub1' }])
  })

  it('leave_noSubscription', async () => {
    const gw = new FakeGateway()
    const views = new SessionViews(gw.client)
    views.adopt({ session_id: 's1', stored_session_id: 'db1' })

    await views.leave(liveSessionId('s1'), 'tui_close')

    expect(gw.sent('session.detach')).toEqual([])
    expect(gw.sent('session.close')).toEqual([])
  })

  it('leave_neverAdopted', async () => {
    const gw = new FakeGateway()
    const views = new SessionViews(gw.client)

    await views.leave(liveSessionId('unknown'), 'tui_close')

    expect(gw.calls).toEqual([])
  })

  it('leave_detaches_without_closing_the_session', async () => {
    const gw = new FakeGateway()
    const views = new SessionViews(gw.client)
    views.adopt(snapshot)

    await views.leave(liveSessionId('s1'), 'tui_close')

    expect(gw.sent('session.close')).toEqual([])
    expect(gw.sent('session.detach')).toEqual([{ end_reason: 'tui_close', session_id: 's1', subscription_id: 'sub1' }])
  })

  it('leave_errorSwallowed', async () => {
    const gw = new FakeGateway()
    gw.handlers.set('session.detach', () => {
      throw new Error('already detached')
    })
    const views = new SessionViews(gw.client)
    views.adopt(snapshot)

    await expect(views.leave(liveSessionId('s1'), 'tui_close')).resolves.toBeUndefined()

    expect(gw.sent('session.close')).toEqual([])
    expect(gw.sent('session.detach')).toEqual([{ end_reason: 'tui_close', session_id: 's1', subscription_id: 'sub1' }])
  })

  it('leaveAll', async () => {
    const gw = new FakeGateway()
    const views = new SessionViews(gw.client)
    views.adopt(snapshot)
    views.adopt({ session_id: 's2', stored_session_id: 'db2', subscription_id: 'sub2' })

    await expect(views.leaveAll('tui_shutdown')).resolves.toEqual([undefined, undefined])

    expect(gw.sent('session.detach')).toEqual([
      { end_reason: 'tui_shutdown', session_id: 's1', subscription_id: 'sub1' },
      { end_reason: 'tui_shutdown', session_id: 's2', subscription_id: 'sub2' }
    ])
    expect(gw.sent('session.close')).toEqual([])
  })

  it('leaveAll_withoutSubscriptionsSendsNothing', async () => {
    const gw = new FakeGateway()
    const views = new SessionViews(gw.client)
    views.adopt({ session_id: 's1', stored_session_id: 'db1' })
    views.adopt({ session_id: 's2', stored_session_id: 'db2' })

    await expect(views.leaveAll('tui_shutdown')).resolves.toEqual([])

    expect(gw.sent('session.close')).toEqual([])
    expect(gw.sent('session.detach')).toEqual([])
  })

  it('detach_errorSwallowed', async () => {
    const gw = new FakeGateway()
    gw.handlers.set('session.detach', () => {
      throw new Error('detached elsewhere')
    })
    const views = new SessionViews(gw.client)
    views.adopt(snapshot)

    await expect(views.leave(liveSessionId('s1'), 'tui_close')).resolves.toBeUndefined()

    expect(gw.sent('session.detach')).toEqual([{ end_reason: 'tui_close', session_id: 's1', subscription_id: 'sub1' }])
  })

  it('detaching_inFlight', async () => {
    const gw = new FakeGateway()
    let resolveGate!: () => void
    const gate = new Promise<void>(resolve => {
      resolveGate = resolve
    })
    gw.handlers.set('session.detach', () => gate)
    const views = new SessionViews(gw.client)
    views.adopt(snapshot)

    const leaving = views.leave(liveSessionId('s1'), 'tui_close')

    expect(views.detaching(liveSessionId('s1'))).toBeDefined()
    expect(views.detaching(storedSessionId('unknown'))).toBeUndefined()
    expect(gw.sent('session.detach')).toEqual([{ end_reason: 'tui_close', session_id: 's1', subscription_id: 'sub1' }])

    resolveGate()
    await leaving
    await flush()

    expect(views.detaching(liveSessionId('s1'))).toBeUndefined()
  })

  it('detach_serialisedPerSession', async () => {
    const gw = new FakeGateway()
    let resolveGate!: () => void
    const gate = new Promise<void>(resolve => {
      resolveGate = resolve
    })
    gw.handlers.set('session.detach', p => (p['subscription_id'] === 'sub1' ? gate : {}))
    const views = new SessionViews(gw.client)
    views.adopt(snapshot)

    const leaving = views.leave(liveSessionId('s1'), 'tui_close')
    views.superseded({ session_id: 's1', subscription_id: 'sub2' })
    views.release(null)

    expect(gw.sent('session.detach')).toEqual([{ end_reason: 'tui_close', session_id: 's1', subscription_id: 'sub1' }])

    resolveGate()
    await leaving
    await flush()

    expect(gw.sent('session.detach')).toEqual([
      { end_reason: 'tui_close', session_id: 's1', subscription_id: 'sub1' },
      { session_id: 's1', subscription_id: 'sub2' }
    ])
    await flush()
    expect(views.detaching(liveSessionId('s1'))).toBeUndefined()
  })

  it('release_skipsShown', async () => {
    const gw = new FakeGateway()
    const views = new SessionViews(gw.client)
    views.superseded({ session_id: 's2', subscription_id: 'sub9' })

    views.release(liveSessionId('s2'))
    await flush()

    expect(gw.calls).toEqual([])
  })

  it('release_skipsHeld', async () => {
    const gw = new FakeGateway()
    const views = new SessionViews(gw.client)
    views.adopt({ session_id: 's3', subscription_id: 'sub3' })
    views.superseded({ session_id: 's3', subscription_id: 'sub3' })

    views.release(null)
    await flush()

    expect(gw.calls).toEqual([])
  })

  it('release_detachesOthers', async () => {
    const gw = new FakeGateway()
    const views = new SessionViews(gw.client)
    views.superseded({ session_id: 's4', subscription_id: 'sub4' })

    views.release(liveSessionId('s1'))
    await flush()

    expect(gw.sent('session.detach')).toEqual([{ session_id: 's4', subscription_id: 'sub4' }])
    expect(gw.sent('session.close')).toEqual([])
  })

  it('release_noSubscription', async () => {
    const gw = new FakeGateway()
    const views = new SessionViews(gw.client)
    views.superseded({ session_id: 's4' })

    views.release(null)
    await flush()

    expect(gw.calls).toEqual([])
  })

  it('release_detachesSupersededSubscription', async () => {
    const gw = new FakeGateway()
    const views = new SessionViews(gw.client)
    views.superseded({ session_id: 's5', subscription_id: 'sub5' })

    views.release(liveSessionId('s1'))
    await flush()

    expect(gw.sent('session.close')).toEqual([])
    expect(gw.sent('session.detach')).toEqual([{ session_id: 's5', subscription_id: 'sub5' }])
  })

  it('release_skipsShownSubscription', async () => {
    const gw = new FakeGateway()
    const views = new SessionViews(gw.client)
    views.superseded({ session_id: 's5', subscription_id: 'sub5' })

    views.release(liveSessionId('s5'))
    await flush()

    expect(gw.calls).toEqual([])
  })

  it('release_errorSwallowed', async () => {
    const gw = new FakeGateway()
    gw.handlers.set('session.detach', () => {
      throw new Error('already gone')
    })
    const views = new SessionViews(gw.client)
    views.superseded({ session_id: 's5', subscription_id: 'sub5' })

    views.release(null)
    await flush()

    expect(gw.sent('session.detach')).toEqual([{ session_id: 's5', subscription_id: 'sub5' }])
    expect(gw.sent('session.close')).toEqual([])
  })

  it('release_clearsStale', async () => {
    const gw = new FakeGateway()
    const views = new SessionViews(gw.client)
    views.superseded({ session_id: 's4', subscription_id: 'sub4' })

    views.release(null)
    await flush()
    views.release(null)
    await flush()

    expect(gw.sent('session.detach')).toEqual([{ session_id: 's4', subscription_id: 'sub4' }])
  })
})
