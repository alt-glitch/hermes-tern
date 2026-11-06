import { EventEmitter } from 'node:events'
import type { GatewayClient } from '@tui/gatewayClient.js'
import { describe, expect, it, vi } from 'vitest'
import { TalkGateway } from '../voice/talk-gateway.js'
import { isTalkToggleKey } from '../voice/hold.js'
import { effectiveShortcuts } from '../shortcuts/actions.js'
import { key, stub } from './fakes.js'

function backend(reply: (p: Record<string, unknown>) => unknown) {
  const events = new EventEmitter()
  const request = vi.fn(async (_method: string, p: Record<string, unknown> = {}) => reply(p))
  const gw = stub<GatewayClient>({ request, on: events.on.bind(events), off: events.off.bind(events) })
  const talk = new TalkGateway(gw)
  return { talk, request, events }
}
const receipt = (id: string, phase = 'listening', active = true) => ({
  type: 'plugin', output: JSON.stringify({ live_id: id, phase, active, error: '' })
})

describe('Talk transport safety', () => {
  it('uses only the public command path and releases only after the backend confirms cleanup', async () => {
    const f = backend(p => {
      const [action, id = ''] = String(p['arg']).split(' ')
      return receipt(id, action === 'stop' ? 'idle' : 'listening', action !== 'stop')
    })
    const events: unknown[] = []
    f.talk.on('event', e => events.push(e))
    try {
      await f.talk.request('voice.live.start', { session_id: 's', live_id: 'id' })
      expect(f.request).toHaveBeenCalledWith('command.dispatch', { session_id: 's', name: 'tern-talk', arg: 'start id' })
      await expect(f.talk.request('voice.live.start', { session_id: 's', live_id: 'second' })).rejects.toThrow('already')
      await f.talk.request('voice.live.control', { session_id: 's', live_id: 'id', action: 'stop' })
      expect(events.at(-1)).toMatchObject({ session_id: 's', payload: { live_id: 'id', phase: 'idle' } })
    } finally { f.talk.dispose() }
  })

  it('does not accept a foreign call receipt', async () => {
    const f = backend(() => receipt('foreign'))
    try {
      await expect(f.talk.request('voice.live.start', { session_id: 's', live_id: 'id' })).rejects.toThrow('identity')
    } finally { f.talk.dispose() }
  })

  it('stops heartbeat work on disconnect, and never starts a call merely on construction', async () => {
    vi.useFakeTimers()
    const f = backend(() => receipt('id'))
    try {
      expect(f.request).not.toHaveBeenCalled()
      await f.talk.request('voice.live.start', { session_id: 's', live_id: 'id' })
      f.events.emit('exit')
      const count = f.request.mock.calls.length
      await vi.advanceTimersByTimeAsync(2000)
      expect(f.request).toHaveBeenCalledTimes(count)
    } finally { f.talk.dispose(); vi.useRealTimers() }
  })

  it('reserves exactly Ctrl+L across all modifiers and rejects conflicting profile overrides', () => {
    for (let mask = 0; mask < 16; mask++) {
      expect(isTalkToggleKey(key('l', { ctrl: Boolean(mask & 1), alt: Boolean(mask & 2), shift: Boolean(mask & 4), meta: Boolean(mask & 8) }))).toBe(mask === 1)
    }
    expect(() => effectiveShortcuts({ 'app.help': 'ctrl+l' })).toThrow()
  })
})
