// The session's title and thoughts flag on fake hosts, with no App: where the title comes from,
// the session-list read a moment after the list changed, `/new <title>`'s rename, and the
// thoughts flag read from the settings at each session.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { liveSessionId, type SessionIds, storedSessionId } from '../core/ids.js'
import type { Settings } from '../settings.js'

import { FakeGateway } from './fakes.js'

const tabs: string[] = []

vi.mock('../surface/osc.js', () => ({ setTabTitle: (title: string) => void tabs.push(title) }))

const { SessionTitle } = await import('../session/title.js')
const { showThoughts } = await import('../session/thoughts.js')

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

describe('SessionTitle', () => {
  it('names the tab once per new title, trimmed, and skips an empty one', () => {
    const title = new SessionTitle(host(new FakeGateway()))

    expect(title.set('  Release notes ')).toBe(true)
    expect(title.set('Release notes')).toBe(false)
    expect(title.set('   ')).toBe(false)
    expect(title.set(undefined)).toBe(false)
    expect(title.text).toBe('Release notes')
    expect(tabs).toEqual(['Release notes'])
  })

  it('reads the list 400 ms after the last change, and finds the session by its stored id', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const gw = new FakeGateway()
    gw.handlers.set('session.list', () => ({ sessions: [{ id: 'other', title: 'Not this' }, { id: 'db1', title: 'Fix the dock' }] }))
    const h = host(gw)
    const title = new SessionTitle(h)

    title.read()
    await vi.advanceTimersByTimeAsync(300)
    title.read()
    await vi.advanceTimersByTimeAsync(399)
    expect(gw.sent('session.list')).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(gw.sent('session.list')).toEqual([{ limit: 20 }])
    expect(title.text).toBe('Fix the dock')
    expect(h.changed).toHaveBeenCalledTimes(1)
  })

  it('drops a list read the session switched away from', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const gw = new FakeGateway()
    const h = host(gw)
    gw.handlers.set('session.list', () => {
      h.ids = { live: liveSessionId('s2'), stored: null }

      return { sessions: [{ id: 's1', title: 'Old' }] }
    })
    const title = new SessionTitle(h)

    title.read()
    await vi.advanceTimersByTimeAsync(400)
    expect(title.text).toBe('')
    expect(h.changed).not.toHaveBeenCalled()
  })

  it('adopt() starts over with the new session\'s title, and dispose() stops the read', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const gw = new FakeGateway()
    const title = new SessionTitle(host(gw))

    title.set('First')
    title.adopt(undefined)
    expect(title.text).toBe('')
    title.adopt('First')
    expect(tabs).toEqual(['First', 'First'])
    expect(vi.getTimerCount()).toBe(1)

    title.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renames through session.title on a private gateway, and says so when it fails', async () => {
    const gw = new FakeGateway({ canonical: false })
    gw.handlers.set('session.title', () => ({ title: 'Named' }))
    const h = host(gw)
    const title = new SessionTitle(h)

    await title.rename(live, 'Asked')
    expect(gw.sent('session.title')).toEqual([{ session_id: 's1', title: 'Asked' }])
    expect(title.text).toBe('Named')
    expect(h.changed).toHaveBeenCalledTimes(1)

    gw.handlers.set('session.title', () => {
      throw new Error('no such session')
    })
    await title.rename(live, 'Again')
    expect(h.notice).toHaveBeenCalledWith('Could not name the session: no such session', 'warning')
  })
})

describe('showThoughts', () => {
  it('reads the settings at each call, and asks only when thoughts are on', async () => {
    const gw = new FakeGateway()
    let settings: Settings = { thoughts: false }
    const load = vi.fn(() => settings)
    const notice = vi.fn()

    showThoughts({ gw: gw.client, notice, settings: { load } }, live)
    expect(gw.sent('config.set')).toEqual([])

    settings = {}
    showThoughts({ gw: gw.client, notice, settings: { load } }, live)
    expect(load).toHaveBeenCalledTimes(2)
    expect(gw.sent('config.set')).toEqual([{ key: 'show_reasoning', session_id: 's1', value: 'on' }])

    gw.handlers.set('config.set', () => {
      throw new Error('denied')
    })
    showThoughts({ gw: gw.client, notice, settings: { load } }, live)
    await new Promise(resolve => setImmediate(resolve))
    expect(notice).toHaveBeenCalledWith('Could not turn on thoughts: denied', 'warning')
  })
})
