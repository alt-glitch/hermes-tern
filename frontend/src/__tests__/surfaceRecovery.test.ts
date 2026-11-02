// Executable TSP v1 peer regressions: actual pinned @stencil-hq/tern Session/Surface,
// with a strict document model (not a mocked Surface or fabricated ACK).
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { node, Session, type Surface } from '@stencil-hq/tern'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { App } from '../app/chat.js'
import { orbSvg, type OrbState, ThinkingOrb } from '../chrome/orb.js'
import { readLaunchEnv } from '../config/env.js'
import { entryId } from '../core/ids.js'
import { ACK_STALL_MS, MAX_SURFACE_RECOVERIES } from '../surface/lifecycle.js'
import { INPUT_ID } from '../surface/host.js'

import { FakeGateway, stubOverlay } from './fakes.js'
import { Peer } from './surfacePeer.js'

vi.mock('../../assets/logo.png', () => ({ default: new Uint8Array([137, 80, 78, 71]) }))


const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function painted() {
  for (let i = 0; i < 8; i++) {
    await turn()
  }
}

const ORB_STATES: readonly OrbState[] = ['idle', 'working', 'thinking', 'composing', 'listening', 'speaking', 'waiting', 'error']

/** Direct animation updates, separate from whole-view frames and focus operations. */
function orbSets(peer: Peer, sf: string) {
  return peer.frames.flatMap(frame => frame.sf === sf
    ? frame.ops.filter(op => Array.isArray(op) && op[0] === 'set' && op[1] === 'dock.composer.line.orb')
    : [])
}

interface Harness {
  readonly app: App
  readonly gw: FakeGateway
  readonly tern: Session
  readonly peer: Peer
  surface(): Surface
  event(body: Record<string, unknown>): Promise<void>
  batch(events: Record<string, unknown>[]): Promise<void>
  ack(sf: string, s: number): Promise<void>
}

async function withApp(
  check: (h: Harness) => Promise<void>,
  options: { retention?: boolean; credits?: number; blobs?: boolean } = {}
) {
  const home = mkdtempSync(join(tmpdir(), 'hermes-surface-recovery-'))
  const previous = process.env['HERMES_HOME']
  process.env['HERMES_HOME'] = home

  const input = new EventEmitter()
  const peer = new Peer()
  const tern = new Session(input, { write: bytes => peer.write(bytes) }, { exitHooks: false, record: '' })
  const hello = tern.handshake()
  input.emit('data', '\x1b_tsp;r;' + JSON.stringify({
    ...tern.caps,
    r: 'hello', v: 1, term: 'strict-peer', ver: '0',
    features: [...(options.retention === false ? [] : ['settle']), ...(options.blobs ? ['blobs'] : [])],
    credits: options.credits ?? 64, apc: 1048576
  }) + '\x1b\\')

  let app: App | undefined
  let running: Promise<number> | undefined

  try {
    expect(await hello).toBe(true)
    const gw = new FakeGateway({
      replies: {
        'setup.status': () => ({ provider_configured: true }),
        'session.create': () => ({ session_id: 's1', subscription_id: 'sub1' })
      }
    })
    app = new App(tern, gw.client, 'test', { launch: readLaunchEnv({ HOME: home, HERMES_HOME: home }, home) })
    running = app.run()
    gw.event({ type: 'gateway.ready', payload: {} })
    await painted()
    const harness: Harness = {
      app, gw, tern, peer,
      surface: () => {
        const surface = tern.surfaces[0]
        if (!surface) {
          throw new Error('expected one open SDK surface')
        }
        return surface
      },
      batch: async events => {
        input.emit('data', events.map(body => '\x1b_tsp;e;' + JSON.stringify(body) + '\x1b\\').join(''))
        await painted()
      },
      event: async body => {
        input.emit('data', '\x1b_tsp;e;' + JSON.stringify(body) + '\x1b\\')
        await painted()
      },
      ack: async (sf, s) => {
        input.emit('data', '\x1b_tsp;e;' + JSON.stringify({ ev: 'ack', sf, s }) + '\x1b\\')
        await painted()
      }
    }
    await check(harness)
  } finally {
    vi.useRealTimers()
    app?.quit()
    if (running) {
      await running
    } else {
      await tern.close()
    }
    if (previous === undefined) {
      delete process.env['HERMES_HOME']
    } else {
      process.env['HERMES_HOME'] = previous
    }
    rmSync(home, { recursive: true, force: true })
  }
}

function fillHistory(app: App) {
  for (let i = 0; i < 25; i++) {
    app.transcript.push({ at: 1, id: entryId('u' + i), kind: 'user', text: 'Prompt ' + i })
    app.transcript.push({
      blocks: [{ id: entryId('x' + i), kind: 'text', text: 'Answer ' + i }],
      end: { status: 'done', endedAt: 2 },
      id: entryId('t' + i), kind: 'turn', rev: 1, startedAt: 1
    })
  }
  app.changed()
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('whole Tern document recovery with real SDK frames', () => {
  it('keeps an idle recovered orb still until activity starts', async () => {
    await withApp(async h => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      const old = h.surface()
      vi.advanceTimersByTime(200)
      expect(orbSets(h.peer, old.id)).toHaveLength(0)
      h.peer.remove(old.id, old.id)
      await h.event({ ev: 'gone', sf: old.id, ids: [old.id] })
      const current = h.surface()
      vi.advanceTimersByTime(200)
      expect(orbSets(h.peer, current.id)).toHaveLength(0)
      h.gw.event({ type: 'message.start', session_id: 's1', payload: {} })
      await painted()
      vi.advanceTimersByTime(200)
      expect(orbSets(h.peer, current.id).length).toBeGreaterThan(0)
    }, { blobs: true })
  })

  it('rebinds an active orb on repeated recoveries and stops old animation timers', async () => {
    await withApp(async h => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      const close = vi.spyOn(ThinkingOrb.prototype, 'close')
      h.gw.event({ type: 'message.start', session_id: 's1', payload: {} })
      await painted()
      let current = h.surface()
      vi.advanceTimersByTime(200)
      expect(orbSets(h.peer, current.id).length).toBeGreaterThan(0)

      for (let i = 1; i <= MAX_SURFACE_RECOVERIES; i++) {
        const old = current
        h.peer.remove(old.id, old.id)
        await h.event({ ev: 'gone', sf: old.id, ids: [old.id] })
        current = h.surface()
        expect(current.id).toBe(`hermes.recovery-${i}`)
        const previous = orbSets(h.peer, old.id).length
        vi.advanceTimersByTime(200)
        expect(orbSets(h.peer, old.id)).toHaveLength(previous)
        expect(orbSets(h.peer, current.id).length).toBeGreaterThan(0)
      }
      expect(close.mock.calls.length).toBeGreaterThanOrEqual(MAX_SURFACE_RECOVERIES)
      const closes = close.mock.calls.length
      h.app.quit()
      await painted()
      const final = orbSets(h.peer, current.id).length
      vi.advanceTimersByTime(200)
      expect(orbSets(h.peer, current.id)).toHaveLength(final)
      expect(close.mock.calls.length).toBeGreaterThan(closes)
    }, { blobs: true })
  })

  it('restores activity, theme and reduced motion after hidden loss and show', async () => {
    await withApp(async h => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      const blob = vi.spyOn(h.tern, 'blob')
      h.gw.event({ type: 'message.start', session_id: 's1', payload: {} })
      await painted()
      const old = h.surface()
      await h.event({ ev: 'theme', dark: false })
      await h.event({ ev: 'motion', reduce: true })
      await h.event({ ev: 'visible', sf: old.id, visible: false })
      const previous = orbSets(h.peer, old.id).length
      h.peer.remove(old.id, old.id)
      await h.event({ ev: 'gone', sf: old.id, ids: [old.id] })
      vi.advanceTimersByTime(200)
      expect(h.tern.surfaces).toHaveLength(0)
      expect(orbSets(h.peer, old.id)).toHaveLength(previous)
      await h.event({ ev: 'visible', visible: true })
      const current = h.surface()
      expect(current.id).toBe('hermes.recovery-1')
      vi.advanceTimersByTime(200)
      expect(orbSets(h.peer, current.id)).toHaveLength(0)
      const light = new Set(ORB_STATES.map(state => orbSvg(state, 0, false)))
      expect(ORB_STATES.filter(state => light.has(orbSvg(state, 0, true)))).toEqual([])
      expect(blob.mock.calls.some(([bytes, mime]) => mime === 'image/svg+xml' && light.has(Buffer.from(bytes).toString()))).toBe(true)
      await h.event({ ev: 'motion', reduce: false })
      vi.advanceTimersByTime(200)
      expect(orbSets(h.peer, current.id).length).toBeGreaterThan(0)
      h.gw.event({ type: 'message.complete', session_id: 's1', payload: { status: 'done' } })
      await painted()
      const done = orbSets(h.peer, current.id).length
      vi.advanceTimersByTime(200)
      expect(orbSets(h.peer, current.id)).toHaveLength(done)
    }, { blobs: true })
  })

  it('keeps the orb alive across hidden child eviction without a whole-surface recovery', async () => {
    await withApp(async h => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      h.gw.event({ type: 'message.start', session_id: 's1', payload: {} })
      await painted()
      const current = h.surface()
      vi.advanceTimersByTime(200)
      expect(orbSets(h.peer, current.id).length).toBeGreaterThan(0)
      await h.event({ ev: 'visible', sf: current.id, visible: false })
      const before = orbSets(h.peer, current.id).length
      h.peer.remove(current.id, INPUT_ID)
      await h.event({ ev: 'gone', sf: current.id, ids: [INPUT_ID] })
      vi.advanceTimersByTime(200)
      expect(orbSets(h.peer, current.id)).toHaveLength(before)
      await h.event({ ev: 'visible', sf: current.id, visible: true })
      expect(h.surface()).toBe(current)
      vi.advanceTimersByTime(200)
      expect(orbSets(h.peer, current.id).length).toBeGreaterThan(before)
    }, { blobs: true })
  })

  it('does not animate a recovered orb while the SDK waits for frame credit', async () => {
    await withApp(async h => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      h.gw.event({ type: 'message.start', session_id: 's1', payload: {} })
      await painted()
      const old = h.surface()
      h.peer.remove(old.id, old.id)
      await h.event({ ev: 'gone', sf: old.id, ids: [old.id] })
      const current = h.surface()
      expect(current.blocked).toBe(true)
      vi.advanceTimersByTime(500)
      expect(orbSets(h.peer, current.id)).toHaveLength(0)
      await h.ack(old.id, old.seq)
      expect(current.blocked).toBe(true)
      for (let i = 0; i < 5 && current.blocked; i++) await h.ack(current.id, current.seq)
      expect(current.blocked).toBe(false)
      vi.advanceTimersByTime(200)
      expect(orbSets(h.peer, current.id).length).toBeGreaterThan(0)
    }, { blobs: true, credits: 1 })
  })

  it.each([true, false])('reopens a fresh document without losing chrome, palette, transcript or draft (settle=%s)', async retention => {
    await withApp(async h => {
      fillHistory(h.app)
      h.app.stores.composer.set('draft survives', { cursor: 5 })
      h.app.open(stubOverlay('held', { modal: true }))
      await painted()
      const old = h.surface()
      const originalGatewayIntents = h.gw.calls.length
      const firstPalette = h.peer.palettes.at(-1)
      h.peer.remove(old.id, old.id)
      await h.event({ ev: 'gone', sf: old.id, ids: [old.id] })

      const now = h.surface()
      expect(now.id).toBe('hermes.recovery-1')
      expect(old.closed).toBe(true)
      expect(h.peer.documents.get(now.id)?.has(INPUT_ID)).toBe(true)
      expect(h.peer.documents.get(now.id)?.has('main.u24')).toBe(true)
      expect(h.app.overlays.some(o => o.key === 'held')).toBe(true)
      expect(h.peer.documents.get(now.id)?.has('layer')).toBe(true)
      expect(h.peer.palettes.at(-1)).toMatchObject({ ...firstPalette, sf: now.id })
      expect(h.app.stores.composer.text).toBe('draft survives')
      expect(h.app.stores.composer.cursor).toBe(5)
      expect(h.gw.calls.length).toBe(originalGatewayIntents)
    }, { retention })
  })

  it('does not credit a new epoch with a late ACK or run a held old handler', async () => {
    await withApp(async h => {
      await h.ack(h.surface().id, h.surface().seq) // First real ACK flushes deferred caret.
      await h.ack(h.surface().id, h.surface().seq) // Second real ACK frees its focus frame.
      h.app.transcript.push({ at: 1, id: entryId('old'), kind: 'user', text: 'Never copy me' })
      h.app.changed()
      await painted()
      const pending = h.peer.frames.at(-1)
      if (h.surface().blocked && pending?.sf === h.surface().id) {
        // Credit only the peer's actual outstanding frame before capturing its new row.
        await h.ack(pending.sf, pending.s)
      }
      const old = h.surface()
      expect(h.peer.documents.get(old.id)?.has('main.old.tools.copy')).toBe(true)
      const action = old.dispatch({ ev: 'action', sf: old.id, id: 'main.old.tools.copy', act: 'click', raw: {} })
      expect(action).toBeTypeOf('function')
      await h.event({ ev: 'gone', sf: old.id, ids: [old.id] })
      const fresh = h.surface()
      expect(fresh.blocked).toBe(true)
      await action?.()
      expect(old.dispatch({ ev: 'action', sf: old.id, id: 'main.old.tools.copy', act: 'click', raw: {} })).toBeUndefined()
      h.app.stores.composer.set('changed after detach')
      h.app.changed()
      await painted()
      const count = h.peer.frames.length
      await h.ack(old.id, old.seq)
      await h.ack(fresh.id, fresh.seq + 500)
      expect(h.peer.frames).toHaveLength(count)
      expect(fresh.blocked).toBe(true)
      await h.ack(fresh.id, fresh.seq)
      expect(h.peer.frames.length).toBeGreaterThan(count)
    }, { credits: 1 })
  })

  it.each([true, false])('routes recovered visibility to notices without accepting stale surface events (settle=%s)', async retention => {
    await withApp(async h => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      h.gw.event({ type: 'message.start', session_id: 's1', payload: {} })
      await painted()
      const old = h.surface()
      h.peer.remove(old.id, old.id)
      await h.event({ ev: 'gone', sf: old.id, ids: [old.id] })
      const current = h.surface()
      expect(current.id).toBe('hermes.recovery-1')
      h.app.stores.composer.set('untouched', { cursor: 3 })
      const modal = stubOverlay('held-modal', { modal: true })
      h.app.open(modal)
      await painted()
      expect(JSON.stringify(h.peer.frames.filter(frame => frame.sf === current.id))).toContain('"sendable":false')
      await h.event({ ev: 'visible', sf: current.id, visible: false })
      h.gw.event({ type: 'notification.show', session_id: 's1', payload: { key: 'held', text: 'Pending notice', kind: 'ttl', ttl_ms: 60_000 } })
      await painted()
      expect(h.app.stores.notices.current()).toBeUndefined()
      await h.event({ ev: 'visible', sf: old.id, visible: true })
      await h.event({ ev: 'resize', sf: old.id, cols: 77, visible: true })
      // The pinned Session updates caps before App can reject a stale resize.
      expect(h.tern.caps.cols).toBe(77)
      await h.event({ ev: 'visible', sf: current.id, visible: 'bad' })
      await h.event({ ev: 'resize', sf: current.id, visible: true })
      expect(h.app.stores.notices.current()).toBeUndefined()
      await h.event({ ev: 'resize', sf: current.id, cols: 90, visible: true })
      expect(h.tern.caps.cols).toBe(90)
      expect(h.app.stores.notices.current()?.text).toBe('Pending notice')
      expect(h.app.stores.notices.current()?.expires).toBeGreaterThan(Date.now())
      expect(h.app.stores.composer.text).toBe('untouched')
      expect(h.app.stores.composer.cursor).toBe(3)
      await h.event({ ev: 'send', sf: current.id, id: INPUT_ID, text: 'should not send' })
      expect(h.gw.sent('prompt.submit')).toEqual([])
      expect(h.app.stores.composer.text).toBe('untouched')
      expect(h.app.overlays.at(-1)?.key).toBe('held-modal')
      const paused = orbSets(h.peer, current.id).length
      vi.advanceTimersByTime(200)
      expect(orbSets(h.peer, current.id)).toHaveLength(paused)
      h.app.close(modal)
      await painted()
      vi.advanceTimersByTime(200)
      expect(orbSets(h.peer, current.id).length).toBeGreaterThan(paused)
      await h.event({ ev: 'visible', sf: old.id, visible: false })
      h.app.stores.notices.show({ key: 'fresh', text: 'Still visible', kind: 'sticky' })
      expect(h.app.stores.notices.current()?.text).toBe('Still visible')
    }, { retention, blobs: true })
  })

  it('holds a real hidden-turn completion notice through a stale show after recovery', async () => {
    await withApp(async h => {
      const old = h.surface()
      h.peer.remove(old.id, old.id)
      await h.event({ ev: 'gone', sf: old.id, ids: [old.id] })
      const current = h.surface()
      await h.event({ ev: 'visible', sf: current.id, visible: false })
      await h.event({ ev: 'visible', sf: old.id, visible: true })
      h.gw.event({ type: 'message.start', session_id: 's1', payload: {} })
      h.gw.event({ type: 'message.complete', session_id: 's1', payload: { status: 'done' } })
      await painted()
      expect(h.app.stores.notices.current()).toBeUndefined()
      await h.event({ ev: 'visible', sf: current.id, visible: true })
      expect(h.app.stores.notices.current()?.text).toBe('A Hermes turn finished while this pane was hidden.')
    })
  })

  it('routes global theme, motion and visibility while retaining a detached owner until show', async () => {
    const environment = vi.spyOn(ThinkingOrb.prototype, 'environment')
    await withApp(async h => {
      const old = h.surface()
      await h.event({ ev: 'theme', dark: false })
      await h.event({ ev: 'motion', reduce: true })
      expect(environment).toHaveBeenCalledWith({ dark: false })
      expect(environment).toHaveBeenCalledWith({ reduce: true })
      await h.event({ ev: 'visible', sf: old.id, visible: false })
      h.app.stores.notices.show({ key: 'held', text: 'While detached', kind: 'ttl', ttl_ms: 60_000 })
      h.peer.remove(old.id, old.id)
      await h.event({ ev: 'gone', sf: old.id, ids: [old.id] })
      expect(h.tern.surfaces).toHaveLength(0)
      await h.event({ ev: 'visible', sf: old.id, visible: true })
      expect(h.surface().id).toBe('hermes.recovery-1')
      expect(h.app.stores.notices.current()?.text).toBe('While detached')
      await h.event({ ev: 'theme', dark: true })
      await h.event({ ev: 'motion', reduce: false })
      expect(environment).toHaveBeenCalledWith({ dark: true })
      expect(environment).toHaveBeenCalledWith({ reduce: false })
      await h.event({ ev: 'visible', visible: false })
      h.app.stores.notices.show({ key: 'global', text: 'Global show', kind: 'ttl', ttl_ms: 60_000 })
      expect(h.app.stores.notices.current()?.text).not.toBe('Global show')
      await h.event({ ev: 'visible', visible: true })
      expect(h.app.stores.notices.current()?.text).toBe('Global show')
    }, { blobs: true })
  })

  it('waits for an explicit show edge after hidden document loss, and never polls', async () => {
    await withApp(async h => {
      const old = h.surface()
      await h.event({ ev: 'visible', sf: old.id, visible: false })
      await h.event({ ev: 'gone', sf: old.id, ids: [old.id] })
      expect(h.tern.surfaces).toHaveLength(0)
      expect(h.peer.opened).toEqual(['hermes'])
      await h.event({ ev: 'visible', visible: true })
      expect(h.surface().id).toBe('hermes.recovery-1')
      expect(h.peer.opened).toEqual(['hermes', 'hermes.recovery-1'])
    })
  })

  it('stops after three distinct replacements; children never spend that budget', async () => {
    const diagnostic = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    await withApp(async h => {
      for (let i = 0; i < MAX_SURFACE_RECOVERIES; i++) {
        const current = h.surface()
        await h.event({ ev: 'gone', sf: current.id, ids: [current.id] })
      }
      expect(h.peer.opened).toHaveLength(MAX_SURFACE_RECOVERIES + 1)
      const final = h.surface()
      await h.event({ ev: 'gone', sf: final.id, ids: [final.id] })
      expect(h.tern.surfaces).toHaveLength(0)
      expect(h.peer.opened).toHaveLength(MAX_SURFACE_RECOVERIES + 1)
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('recovery limit'))
    })
  })
})

describe('evictions, failure and shutdown', () => {
  it('keeps cold history evicted but restores active main and chrome children without sibling invalidation', async () => {
    await withApp(async h => {
      fillHistory(h.app)
      await painted()
      const sf = h.surface().id
      h.peer.remove(sf, 'main.u0')
      await h.event({ ev: 'gone', sf, ids: ['main.u0'] })
      expect(h.peer.documents.get(sf)?.has('main.u0')).toBe(false)
      expect(h.peer.documents.get(sf)?.has('main.retention-load')).toBe(true)

      h.peer.remove(sf, 'main.t24')
      await h.event({ ev: 'gone', sf, ids: ['main.t24'] })
      expect(h.peer.documents.get(sf)?.has('main.t24')).toBe(true)
      h.peer.remove(sf, INPUT_ID)
      await h.event({ ev: 'gone', sf, ids: [INPUT_ID] })
      expect(h.peer.documents.get(sf)?.has(INPUT_ID)).toBe(true)
      expect(h.peer.documents.get(sf)?.has('dock')).toBe(true)
      expect(h.peer.documents.get(sf)?.has('main.u0')).toBe(false)

      // The peer can also discard an entire region, without discarding the document.
      h.peer.remove(sf, 'main')
      await h.event({ ev: 'gone', sf, ids: ['main'] })
      expect(h.peer.documents.get(sf)?.has('main')).toBe(true)
      expect(h.peer.documents.get(sf)?.has('main.t24')).toBe(true)
      expect(h.peer.opened).toHaveLength(1)
    })
  })

  it('reconciles a child without settle, keeping surviving siblings and their IDs', async () => {
    await withApp(async h => {
      const sf = h.surface().id
      const before = new Set(h.peer.documents.get(sf)?.keys())
      h.peer.remove(sf, INPUT_ID)
      await h.event({ ev: 'gone', sf, ids: [INPUT_ID] })
      expect(h.peer.documents.get(sf)?.has(INPUT_ID)).toBe(true)
      for (const id of before) {
        expect(h.peer.documents.get(sf)?.has(id), 'lost sibling ' + id).toBe(true)
      }
      expect(h.peer.opened).toHaveLength(1)
    }, { retention: false })
  })

  it('defers an ACK-triggered redraw behind same-read child gone; never focuses the absent editor', async () => {
    await withApp(async h => {
      const sf = h.surface().id
      const seq = h.surface().seq
      h.peer.remove(sf, INPUT_ID)
      await h.batch([
        { ev: 'gone', sf, ids: [INPUT_ID] },
        { ev: 'ack', sf, s: seq }
      ])
      expect(h.peer.documents.get(sf)?.has(INPUT_ID)).toBe(true)
      expect(h.peer.opened).toHaveLength(1)
    }, { credits: 1 })
  })

  it.each([
    { ev: 'error', sf: 'hermes', s: 1, op: 0, msg: 'bad node' },
    { ev: 'error', sf: 'hermes', msg: 23 },
    { ev: 'ack', sf: 'hermes', s: 'invalid' }
  ])('reports rejected or malformed protocol input once, and fails closed: %j', async error => {
    const diagnostic = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    await withApp(async h => {
      await h.event(error)
      const before = h.peer.frames.length
      h.app.stores.composer.set('unseen text')
      h.app.changed()
      await painted()
      expect(h.peer.frames).toHaveLength(before)
      expect(h.tern.surfaces).toHaveLength(0)
      expect(h.app.transcript.entries.some(e => e.kind === 'notice' && e.text.includes('Tern'))).toBe(true)
      expect(diagnostic).toHaveBeenCalledTimes(1)
    })
  })

  it('stops on a locally malformed duplicate view without replaying any gateway intent', async () => {
    const diagnostic = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    await withApp(async h => {
      const sent = h.gw.calls.length
      h.app.open({
        key: 'bad-view', modal: true, onKey: () => false,
        node: () => node('col', {}, [
          node('text', { key: 'duplicate', text: 'one' }),
          node('text', { key: 'duplicate', text: 'two' })
        ])
      })
      await painted()
      expect(h.tern.surfaces).toHaveLength(0)
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('could not build a frame'))
      expect(h.gw.calls.length).toBe(sent)
    })
  })

  it('reports visible ACK stall only once, pauses hidden work and disposes diagnostics', async () => {
    const diagnostic = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    await withApp(async h => {
      const sf = h.surface().id
      await h.event({ ev: 'visible', sf, visible: false })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await h.event({ ev: 'visible', sf, visible: true })
      const frames = h.peer.frames.length
      await vi.advanceTimersByTimeAsync(ACK_STALL_MS * 3)
      expect(diagnostic).toHaveBeenCalledTimes(1)
      expect(h.peer.frames).toHaveLength(frames)
      await h.event({ ev: 'visible', sf, visible: false })
      await vi.advanceTimersByTimeAsync(ACK_STALL_MS * 2)
      expect(diagnostic).toHaveBeenCalledTimes(1)
      h.app.dispose()
      expect(vi.getTimerCount()).toBe(0)
      await h.event({ ev: 'gone', sf, ids: [sf] })
      expect(h.peer.opened).toEqual(['hermes'])
    }, { credits: 1 })
  })

  it('keeps a held gateway approval and draft alive without responding or resubmitting', async () => {
    await withApp(async h => {
      const respond = vi.fn()
      h.app.stores.composer.set('awaiting review', { cursor: 4 })
      h.gw.emit('request', {
        fail: vi.fn(), id: 'approval-one', method: 'approval',
        params: { command: 'echo safe', session_id: 's1' }, respond
      })
      await painted()
      expect(h.app.overlays.some(o => o.modal)).toBe(true)
      const old = h.surface()
      const count = h.gw.methods('prompt.submit').length
      await h.event({ ev: 'gone', sf: old.id, ids: [old.id] })
      expect(h.peer.documents.get(h.surface().id)?.has(INPUT_ID)).toBe(true)
      expect(h.app.overlays.some(o => o.modal)).toBe(true)
      expect(h.app.stores.composer.text).toBe('awaiting review')
      expect(h.app.stores.composer.cursor).toBe(4)
      expect(respond).not.toHaveBeenCalled()
      expect(h.gw.methods('prompt.submit')).toHaveLength(count)
    })
  })
})
