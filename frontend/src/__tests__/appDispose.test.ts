// What the app owns and ends: an overlay hears when it leaves the stack (closed or replaced), and
// dispose() stops every timer the app armed, so quitting leaves nothing running.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Node, node } from '@stencil-hq/tern'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { readLaunchEnv } from '../config/env.js'
import type { Overlay } from '../overlay.js'
import type { Settings, SettingsSource } from '../settings.js'

import { FakeGateway, fakeTern } from './fakes.js'

const home = mkdtempSync(join(tmpdir(), 'hermes-tern-dispose-'))
process.env['HERMES_HOME'] = home

vi.mock('../clipboard.js', () => ({ copyToClipboard: () => undefined }))
vi.mock('../hermes/sessionIndex.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../hermes/sessionIndex.js')>()),
  lastReply: () => '',
  storedSessions: () => []
}))

const { App } = await import('../app.js')

const flush = () => new Promise(resolve => setImmediate(resolve))

/** Settings held in memory: every read is counted. */
function memorySettings(initial: Settings = {}): SettingsSource & { loads: number; saved: Settings } {
  let saved: Settings = initial

  return {
    load() {
      this.loads++

      return saved
    },
    loads: 0,
    save(patch) {
      saved = { ...saved, ...patch }
      this.saved = saved

      return saved
    },
    saved
  }
}

async function started(settings = memorySettings()) {
  const gw = new FakeGateway()
  gw.handlers.set('setup.status', () => ({ provider_configured: true }))
  gw.handlers.set('session.create', () => ({ info: { stored_session_id: 's1' }, session_id: 's1', subscription_id: 'sub1' }))
  const tern = fakeTern({ draws: true })
  const app = new App(tern.session, gw.client, '', { launch: readLaunchEnv({ HOME: home }, home), settings })
  const done = app.run()
  gw.event({ payload: {}, type: 'gateway.ready' })
  await flush()
  await flush()

  return { app, done, gw, settings, tern }
}

const sheet = (key: string, onClose: () => void): Overlay => ({ key, node: () => node('box', { key }), onClose, onKey: () => false })

afterEach(() => {
  vi.useRealTimers()
})

describe('overlay onClose', () => {
  it('runs once when the overlay closes', async () => {
    const { app } = await started()
    const onClose = vi.fn()
    const o = sheet('one', onClose)

    app.open(o)
    expect(onClose).not.toHaveBeenCalled()

    app.close(o)
    app.close(o)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(app.overlays).toEqual([])
  })

  it('runs for the overlay a same-key overlay replaces, not for the new one', async () => {
    const { app } = await started()
    const first = vi.fn()
    const second = vi.fn()

    app.open(sheet('same', first))
    app.open(sheet('same', second))

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(app.overlays).toHaveLength(1)
  })
})

describe('settings', () => {
  it('reads the settings once at boot, and again for each session\'s thoughts', async () => {
    const settings = memorySettings({ theme: 'nous', thoughts: false })
    const { app, gw } = await started(settings)

    expect(app.theme).toBe('nous')
    // Boot, then the first session's thoughts flag; off, so no config.set.
    expect(settings.loads).toBe(2)
    expect(gw.sent('config.set')).toEqual([])

    app.setTheme('tern')
    expect(settings.saved).toEqual({ theme: 'tern', thoughts: false })
  })
})

/** Every node in a frame's region, depth first. */
function nodes(tree: unknown): Node[] {
  if (tree instanceof Node) {
    return [tree, ...tree.children.flatMap(nodes)]
  }

  return Array.isArray(tree) ? tree.flatMap((n: unknown) => nodes(n)) : []
}

/** The nodes of the transcript region the surface drew last. */
function mainNodes(frame: unknown): Node[] {
  return frame && typeof frame === 'object' && 'main' in frame ? nodes(frame.main) : []
}

describe('App.dispose', () => {
  it('clears every timer the app armed', async () => {
    const { app, gw, tern } = await started()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })

    // The title read after a session-list change.
    gw.event({ type: 'sessions.changed' })
    // The redial line's re-render.
    gw.event({ payload: { attempt: 1, delay_ms: 5000 }, type: 'gateway.reconnecting' })
    // A notice that expires.
    gw.event({ payload: { key: 'credits', kind: 'ttl', text: 'Low credits', ttl_ms: 60_000 }, type: 'notification.show' })
    // A compaction's summary read.
    gw.event({ payload: {}, session_id: 's1', type: 'message.start' })
    gw.event({ payload: { kind: 'compacting', text: 'Compacting context' }, session_id: 's1', type: 'status.update' })
    gw.event({ payload: { kind: 'compacted', text: 'Compacted ~182,000 → ~31,000 tokens' }, session_id: 's1', type: 'status.update' })
    gw.event({ payload: { text: 'Done.' }, session_id: 's1', type: 'message.complete' })
    // A connect card the plugin's watcher still writes.
    const cards = join(home, 'plugin-data', 'hermes-tern', 'connections')
    mkdirSync(cards, { recursive: true })
    writeFileSync(
      join(cards, 'call_c.op1.json'),
      JSON.stringify({
        pid: process.pid,
        settled_by: null,
        targets: [{ connect_url: 'https://portal/x', name: 'googledrive', state: 'initiated' }],
        updated_at: Date.now() / 1000,
        watching: true
      })
    )
    gw.event({
      payload: {
        name: 'manage_connections',
        result: JSON.stringify({ op_id: 'op1', status: 'initiated', targets: [{ name: 'googledrive', state: 'initiated' }] }),
        tool_id: 'call_c'
      },
      session_id: 's1',
      type: 'tool.complete'
    })
    await flush()
    // The answer's Copy button, until it reads Copy again.
    const copy = mainNodes(tern.frame).find(n => n.props['name'] === 'copy' && n.handlers?.onClick)
    expect(copy).toBeDefined()
    void copy?.handlers?.onClick?.({ act: 'click', ev: 'action', id: 'copy', raw: {}, sf: 'hermes' })

    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(6)

    app.dispose()

    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('quitting', () => {
  const viewer = join(home, 'plugin-data', 'hermes-tern', 'viewers', 's1.json')

  it('unmarks the viewer and detaches, then disposes, then closes Tern', async () => {
    const { app, done, gw, tern } = await started()
    const dispose = vi.spyOn(app, 'dispose')
    const close = vi.spyOn(tern.session, 'close')
    expect(existsSync(viewer)).toBe(true)

    app.quit(3)

    await expect(done).resolves.toBe(3)
    expect(existsSync(viewer)).toBe(false)
    expect(gw.sent('session.detach')).toEqual([{ end_reason: 'tui_shutdown', session_id: 's1', subscription_id: 'sub1' }])
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0] ?? 0)
  })

  it('stops waiting for a detach that never answers after QUIT_DETACH_MS', async () => {
    const { app, done, gw, tern } = await started()
    gw.handlers.set('session.detach', () => new Promise(() => undefined))
    const close = vi.spyOn(tern.session, 'close')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    app.quit()
    await vi.advanceTimersByTimeAsync(1499)
    expect(close).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await expect(done).resolves.toBe(0)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
