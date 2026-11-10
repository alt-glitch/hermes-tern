// The pane's viewer state on the plugin's RPC methods (hermes/viewer.ts, viewers.py).

import { describe, expect, it, vi } from 'vitest'

import { liveSessionId, storedSessionId } from '../core/ids.js'
import { ternPane, Viewer, VIEWER_CLEAR, VIEWER_SET, VIEWER_SHOWN } from '../hermes/viewer.js'

import { FakeGateway } from './fakes.js'

/** A fake gateway answering `answer` per method (a thrown error fails the call), else an empty result. */
function gateway(answer: Record<string, () => unknown> = {}) {
  const gw = new FakeGateway()
  gw.handlers.set(VIEWER_SET, () => ({}))
  gw.handlers.set(VIEWER_CLEAR, () => ({}))
  for (const [method, reply] of Object.entries(answer)) {
    gw.handlers.set(method, reply)
  }

  return gw
}

const env = { HOME: '/h', TERN_PANE: '42', TERN_PANE_SOCKET: '/s/pane', TERN_WINDOW_KEY: '' }
const ref = (live: string, stored: string | null = null) => ({ live: liveSessionId(live), stored: stored ? storedSessionId(stored) : null })

describe('the viewer', () => {
  it('sends the pane variables with the session it shows, and clears the one it left', async () => {
    const gw = gateway()
    new Viewer(gw.client, env, 7).show(ref('b', 'b-stored'), ref('a'))
    await Promise.resolve()

    expect(gw.calls).toEqual([
      { method: VIEWER_CLEAR, params: { pid: 7, session_id: 'a' } },
      { method: VIEWER_SET, params: { pid: 7, session_id: 'b', stored: 'b-stored', tern: { TERN_PANE: '42', TERN_PANE_SOCKET: '/s/pane' } } }
    ])
  })

  it('names nothing outside a Tern pane, and clears nothing for the same session', async () => {
    const gw = gateway()
    new Viewer(gw.client, {}, 7).show(ref('a', 'a'), ref('a'))
    await Promise.resolve()

    expect(gw.calls).toEqual([{ method: VIEWER_SET, params: { pid: 7, session_id: 'a', tern: {} } }])
    expect(ternPane({ TERN_WINDOW_KEY: '3' })).toBeUndefined()
  })

  it('asks whether another pane shows a conversation, and reads a gateway without the plugin as no', async () => {
    expect(await new Viewer(gateway({ [VIEWER_SHOWN]: () => ({ shown: true }) }).client, {}, 7).shown('s1')).toBe(true)
    expect(await new Viewer(gateway({ [VIEWER_SHOWN]: () => { throw new Error('unknown method') } }).client, {}, 7).shown('s1')).toBe(false)
  })

  it('clears its exit timeout when the gateway answers before the deadline', async () => {
    vi.useFakeTimers()
    try {
      await new Viewer(gateway().client, {}, 7).leave(ref('a'))
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still exits within its deadline when the gateway never answers', async () => {
    vi.useFakeTimers()
    try {
      const leaving = new Viewer(gateway({ [VIEWER_CLEAR]: () => new Promise(() => undefined) }).client, {}, 7).leave(ref('a'))
      await vi.advanceTimersByTimeAsync(300)
      await leaving
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves quietly when the gateway refuses', async () => {
    const gw = gateway({ [VIEWER_CLEAR]: () => { throw new Error('unknown method') } })
    await new Viewer(gw.client, {}, 7).leave(ref('a'))

    expect(gw.calls.map(c => c.method)).toEqual([VIEWER_CLEAR])
  })
})
