// Uncovered SessionTitle paths: gateway rename receipts and list fallbacks.
// The gateway and OSC tab are in-process fakes; timers are advanced without wall-clock waits.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { liveSessionId, NO_SESSION, type SessionIds, storedSessionId } from '../core/ids.js'

import { FakeGateway } from './fakes.js'

const tabs: string[] = []

vi.mock('../surface/osc.js', () => ({ setTabTitle: (t: string) => void tabs.push(t) }))

const { SessionTitle } = await import('../session/title.js')

const live = liveSessionId('s1')

/** A title host over `gw`, its ids settable, counting renders and notices. */
function host(gw: FakeGateway, ids: SessionIds = { live, stored: storedSessionId('db1') }) {
  const h = {
    changed: vi.fn(),
    gw: gw.client,
    ids,
    notice: vi.fn(),
    session: {
      info: null,
      get ref() {
        return h.ids
      }
    }
  }

  return h
}

afterEach(() => {
  tabs.length = 0
  vi.useRealTimers()
})

describe('SessionTitle uncovered rename and read paths', () => {
  it('renameCanonical: resumes and renames with a revision but no generation fence', async () => {
    const gw = new FakeGateway()
    gw.handlers.set('session.resume', () => ({ revision: 7, execution_generation: 2 }))
    gw.handlers.set('session.mutate', () => ({ title: 'Named' }))
    const h = host(gw)
    const title = new SessionTitle(h)

    await title.rename(live, 'Asked')

    expect(gw.sent('session.resume')).toEqual([{ session_id: 's1' }])
    const mutations = gw.sent('session.mutate')
    expect(mutations).toHaveLength(1)
    expect(mutations[0]).toMatchObject({
      session_id: 's1',
      expected_revision: 7,
      operation: 'rename',
      payload: { title: 'Asked' }
    })
    expect(mutations[0]).not.toHaveProperty('expected_generation')
    expect(mutations[0]?.['request_id']).toEqual(expect.any(String))
    expect(title.text).toBe('Named')
    expect(h.changed).toHaveBeenCalledTimes(1)
    expect(tabs).toEqual(['Named'])
  })

  it('renameCanonicalNoRevision: warns and never sends a mutation', async () => {
    const gw = new FakeGateway()
    gw.handlers.set('session.resume', () => ({}))
    const h = host(gw)
    const title = new SessionTitle(h)

    await title.rename(live, 'Asked')

    expect(gw.sent('session.resume')).toEqual([{ session_id: 's1' }])
    expect(gw.sent('session.mutate')).toEqual([])
    expect(title.text).toBe('')
    expect(h.changed).not.toHaveBeenCalled()
    expect(h.notice).toHaveBeenCalledWith(
      'Could not name the session: The session did not report its revision; try again.',
      'warning'
    )
    expect(tabs).toEqual([])
  })

  it('renameFallsBackToAsked: uses the requested name when the mutation reply has no title', async () => {
    const gw = new FakeGateway()
    gw.handlers.set('session.resume', () => ({ revision: 7, execution_generation: 2 }))
    gw.handlers.set('session.mutate', () => ({}))
    const h = host(gw)
    const title = new SessionTitle(h)

    await title.rename(live, 'Asked')

    expect(gw.sent('session.mutate')).toEqual([expect.objectContaining({ session_id: 's1', operation: 'rename', expected_revision: 7, payload: { title: 'Asked' } })])
    expect(gw.sent('session.title')).toEqual([])
    expect(title.text).toBe('Asked')
    expect(h.changed).toHaveBeenCalledTimes(1)
    expect(tabs).toEqual(['Asked'])
  })

  it('renameOtherSessionIgnored: renames another session without changing the current title', async () => {
    const gw = new FakeGateway()
    gw.handlers.set('session.resume', () => ({ revision: 7, execution_generation: 2 }))
    gw.handlers.set('session.mutate', () => ({ title: 'Elsewhere' }))
    const h = host(gw)
    const title = new SessionTitle(h)

    await title.rename(liveSessionId('s2'), 'X')

    expect(gw.sent('session.mutate')).toEqual([expect.objectContaining({ session_id: 's2', operation: 'rename', expected_revision: 7, payload: { title: 'X' } })])
    expect(gw.sent('session.title')).toEqual([])
    expect(title.text).toBe('')
    expect(h.changed).not.toHaveBeenCalled()
    expect(h.notice).not.toHaveBeenCalled()
    expect(tabs).toEqual([])
  })

  it('renameBlankReply: does not replace a blank reply with the requested name', async () => {
    const gw = new FakeGateway()
    gw.handlers.set('session.resume', () => ({ revision: 7, execution_generation: 2 }))
    gw.handlers.set('session.mutate', () => ({ title: '   ' }))
    const h = host(gw)
    const title = new SessionTitle(h)

    await title.rename(live, 'Asked')

    expect(gw.sent('session.mutate')).toEqual([expect.objectContaining({ session_id: 's1', operation: 'rename', expected_revision: 7, payload: { title: 'Asked' } })])
    expect(gw.sent('session.title')).toEqual([])
    expect(title.text).toBe('')
    expect(h.changed).not.toHaveBeenCalled()
    expect(h.notice).not.toHaveBeenCalled()
    expect(tabs).toEqual([])
  })

  it('readMatchesResolvedId: finds the stored id in resolved_id', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const gw = new FakeGateway()
    gw.handlers.set('session.list', () => ({
      sessions: [{ id: 'x', resolved_id: 'db1', title: 'Resumed' }]
    }))
    const h = host(gw)
    const title = new SessionTitle(h)

    title.read()
    await vi.advanceTimersByTimeAsync(400)

    expect(gw.sent('session.list')).toEqual([{ limit: 20 }])
    expect(title.text).toBe('Resumed')
    expect(h.changed).toHaveBeenCalledTimes(1)
    expect(tabs).toEqual(['Resumed'])
  })

  it('readMatchesLiveId: finds the runtime id without a stored id', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const gw = new FakeGateway()
    gw.handlers.set('session.list', () => ({ sessions: [{ id: 's1', title: 'Live row' }] }))
    const h = host(gw, { live, stored: null })
    const title = new SessionTitle(h)

    title.read()
    await vi.advanceTimersByTimeAsync(400)

    expect(gw.sent('session.list')).toEqual([{ limit: 20 }])
    expect(title.text).toBe('Live row')
    expect(h.changed).toHaveBeenCalledTimes(1)
    expect(tabs).toEqual(['Live row'])
  })

  it('readNoLiveSession: never requests a list for NO_SESSION', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const gw = new FakeGateway()
    const h = host(gw, NO_SESSION)
    const title = new SessionTitle(h)

    title.read()
    await vi.advanceTimersByTimeAsync(400)

    expect(gw.sent('session.list')).toEqual([])
    expect(title.text).toBe('')
    expect(h.changed).not.toHaveBeenCalled()
    expect(tabs).toEqual([])
  })

  it('readListFails: swallows a failed list request without losing the existing title', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const gw = new FakeGateway()
    gw.handlers.set('session.list', () => {
      throw new Error('down')
    })
    const h = host(gw)
    const title = new SessionTitle(h)
    title.set('Keep')

    title.read()
    await vi.advanceTimersByTimeAsync(400)

    expect(gw.sent('session.list')).toEqual([{ limit: 20 }])
    expect(title.text).toBe('Keep')
    expect(h.notice).not.toHaveBeenCalled()
    expect(h.changed).not.toHaveBeenCalled()
    expect(tabs).toEqual(['Keep'])
  })

  it('readNoChange: matching same, untitled and unmatched rows never trigger a render', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    for (const sessions of [
      [{ id: 'db1', title: 'Same' }],
      [{ id: 'db1' }],
      [{ id: 'other', title: 'Different' }]
    ]) {
      const gw = new FakeGateway()
      gw.handlers.set('session.list', () => ({ sessions }))
      const h = host(gw)
      const title = new SessionTitle(h)
      title.set('Same')

      title.read()
      await vi.advanceTimersByTimeAsync(400)

      expect(gw.sent('session.list')).toEqual([{ limit: 20 }])
      expect(title.text).toBe('Same')
      expect(h.changed).not.toHaveBeenCalled()
      expect(h.notice).not.toHaveBeenCalled()
    }

    expect(tabs).toEqual(['Same', 'Same', 'Same'])
  })

  it('disposeBeforeFire: cancels an unread list before the timer fires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const gw = new FakeGateway()
    const h = host(gw)
    const title = new SessionTitle(h)

    title.read()
    title.dispose()
    await vi.advanceTimersByTimeAsync(500)

    expect(gw.sent('session.list')).toEqual([])
    expect(title.text).toBe('')
    expect(h.changed).not.toHaveBeenCalled()
    expect(tabs).toEqual([])
  })
})
