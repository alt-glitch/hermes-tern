import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import type { ConfigGetResult } from '@hermes/shared/gateway-events'
import type { SessionInfo } from '@hermes/shared/gateway-types'
import { describe, expect, it, vi } from 'vitest'

import { liveSessionId } from '../../core/ids.js'
import { SessionState } from '../../session/state.js'
import { record } from '../../wire/json.js'
import { FakeGateway, key, stub } from '../../__tests__/fakes.js'

import { APP_SHORTCUTS } from '../actions.js'
import { BindingPreferences } from '../binding-preferences.js'

const exec = promisify(execFile)
const coreFixture = fileURLToPath(new URL('./fixtures/native-keybindings-profile-core.py', import.meta.url))

/** Pinned tui_gateway/methods_config.py: config.get key=full/profile. */
function full(bindings: unknown = {}, exposed = false): ConfigGetResult {
  return { config: { display: { tern_keybindings: bindings, tern_profile_identity: exposed } } }
}

function profile(name: string): ConfigGetResult {
  return { home: '/hermes/profiles/work', display: name }
}

function fixture(initial: ConfigGetResult = full(), identity = profile('Work')) {
  const session = new SessionState(() => {})
  session.ref = { live: liveSessionId('s1'), stored: null }
  session.info = stub<SessionInfo>({ profile_name: 'a' })
  let stored = initial
  let shown = identity
  const gw = new FakeGateway({ replies: { 'config.get': p => p['key'] === 'profile' ? shown : stored } })
  const notice = vi.fn()
  const changed = vi.fn()
  const prefs = new BindingPreferences({ gw: gw.client, session, changed, notice })
  const owner = () => ({
    ref: session.ref, sid: session.ref.live ?? '', profile: session.info?.profile_name ?? ''
  })

  return {
    gw, prefs, session, owner, notice, changed,
    get sid() { return session.ref.live },
    set sid(value: string | null) {
      session.ref = { live: value ? liveSessionId(value) : null, stored: null }
    },
    set canonical(value: string | null) {
      session.info = value ? stub<SessionInfo>({ profile_name: value }) : null
    },
    set stored(value: ConfigGetResult) { stored = value },
    set identity(value: ConfigGetResult) { shown = value }
  }
}

describe('owning-session binding preferences on pinned config.get', () => {
  it('reads full and opted-in profile identity from the exact session owner', async () => {
    const f = fixture(full({ 'app.help': 'alt+h' }, true))
    expect(f.prefs.profile).toBe('')
    await f.prefs.refresh()
    expect(f.gw.sent('config.get')).toEqual([
      { key: 'full', session_id: 's1', profile: 'a' },
      { key: 'profile', session_id: 's1', profile: 'a' }
    ])
    expect(f.prefs.profile).toBe('Work')
    expect(f.prefs.matches('app.help', key('h', { alt: true }))).toBe(true)
    expect(f.prefs.matches('app.help', key('f1'))).toBe(false)

    f.stored = full({ 'app.help': null }, false)
    await f.prefs.refresh()
    expect(f.gw.sent('config.get').at(-1)).toEqual({ key: 'full', session_id: 's1', profile: 'a' })
    expect(f.prefs.matches('app.help', key('f1'))).toBe(true)
    expect(f.prefs.profile).toBe('')
    expect(f.changed).toHaveBeenCalled()
  })

  it('rejects invalid, overlapping, host-reserved and editor-owned maps atomically', async () => {
    const f = fixture(full({ 'app.help': 'alt+h' }))
    await f.prefs.refresh()

    for (const bindings of [
      { 'app.help': 'alt+a' },
      { 'app.help': 'ctrl+shift+c' },
      { 'app.help': 'ctrl+shift+p' },
      { 'app.help': 'alt+shift+b' },
      { 'app.help': 'alt+shift+v' },
      { 'app.message.dequeue': 'ctrl+alt+backspace' },
      { 'app.help': 'ctrl+shift+k' },
      { 'app.help': 'enter' },
      { 'app.help': 'space' },
      { 'app.help': 'ctrl+ctrl+k' },
      { 'app.help': ['alt+h', 'alt+h'] },
      { 'app.help': 7 },
      null,
      { 'app.help': 'alt+y', 'unknown.action': 'alt+h' }
    ]) {
      f.stored = full(bindings)
      await f.prefs.refresh()
      expect(f.prefs.matches('app.help', key('h', { alt: true }))).toBe(true)
      expect(f.prefs.matches('app.help', key('f1'))).toBe(false)
    }

    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('Overlapping chord'))
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('Duplicate chord'))
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('Host-reserved'))
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('Composer-owned'))
    f.sid = 's2'
    f.canonical = 'b'
    expect(f.prefs.actions).toEqual(APP_SHORTCUTS)
    expect(f.prefs.profile).toBe('')
    f.stored = full({ 'app.help': 'alt+y' })
    await f.prefs.refresh()
    expect(f.prefs.matches('app.help', key('y', { alt: true }))).toBe(true)
  })

  it('discards late full reads after session replacement and after direct accepted readback', async () => {
    const f = fixture()
    const first = Promise.withResolvers<ConfigGetResult>()
    f.gw.handlers.set('config.get', p => p['key'] === 'full' ? first.promise : profile('Work'))
    const pending = f.prefs.refresh()
    await vi.waitFor(() => expect(f.gw.sent('config.get')).toHaveLength(1))
    f.sid = 's2'
    f.canonical = 'b'
    expect(f.prefs.accept(full({ 'app.help': 'alt+h' }, true), f.owner(), profile('Personal'))).toBe(true)
    first.resolve(full({ 'app.help': [] }, true))
    await pending
    expect(f.prefs.profile).toBe('Personal')
    expect(f.prefs.matches('app.help', key('h', { alt: true }))).toBe(true)

    const later = Promise.withResolvers<ConfigGetResult>()
    f.gw.handlers.set('config.get', p => p['key'] === 'full' ? later.promise : profile('Personal'))
    const reading = f.prefs.refresh()
    await vi.waitFor(() => expect(f.gw.sent('config.get')).toHaveLength(2))
    f.prefs.accept(full({ 'app.help': [] }), f.owner())
    later.resolve(full({ 'app.help': 'alt+h' }))
    await reading
    expect(f.prefs.matches('app.help', key('h', { alt: true }))).toBe(false)
  })

  it('does not apply an old profile lookup to the replacement session', async () => {
    const f = fixture(full({ 'app.help': 'alt+h' }, true))
    const pendingIdentity = Promise.withResolvers<ConfigGetResult>()
    f.gw.handlers.set('config.get', p => p['key'] === 'profile' ? pendingIdentity.promise : full({ 'app.help': 'alt+h' }, true))
    const pending = f.prefs.refresh()
    await vi.waitFor(() => expect(f.gw.sent('config.get')).toContainEqual({ key: 'profile', session_id: 's1', profile: 'a' }))
    f.sid = 's2'
    f.canonical = 'b'
    f.prefs.accept(full({ 'app.help': 'alt+y' }, true), f.owner(), profile('New owner'))
    pendingIdentity.resolve(profile('Old owner'))
    await pending
    expect(f.prefs.profile).toBe('New owner')
    expect(f.prefs.matches('app.help', key('y', { alt: true }))).toBe(true)
  })

  it('retains bindings when optional profile identity cannot be fetched', async () => {
    const f = fixture(full({ 'app.help': 'alt+h' }, true))
    f.gw.handlers.set('config.get', p => {
      if (p['key'] === 'profile') throw new Error('Profile lookup unavailable')
      return full({ 'app.help': 'alt+h' }, true)
    })
    await f.prefs.refresh()
    expect(f.prefs.matches('app.help', key('h', { alt: true }))).toBe(true)
    expect(f.prefs.profile).toBe('')
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('Profile lookup unavailable'))
  })

  it('rejects a stale direct accept after owner-ref replacement', async () => {
    const f = fixture()
    const old = f.owner()
    f.sid = 's1'
    f.canonical = 'b'
    expect(f.prefs.accept(full({ 'app.help': 'alt+h' }), old)).toBe(false)
    expect(f.prefs.actions).toBe(APP_SHORTCUTS)
    expect(f.prefs.profile).toBe('')
  })

  it('fences A→B→A with a reused sid, including previously pending full replies', async () => {
    const f = fixture()
    const oldA = Promise.withResolvers<ConfigGetResult>()
    f.gw.handlers.set('config.get', () => oldA.promise)
    const pending = f.prefs.refresh()
    await vi.waitFor(() => expect(f.gw.sent('config.get')).toHaveLength(1))
    const firstRef = f.session.ref
    f.sid = 's1'
    f.canonical = 'b'
    expect(f.session.ref).not.toBe(firstRef)
    expect(f.prefs.actions).toBe(APP_SHORTCUTS)
    expect(f.prefs.accept(full({ 'app.help': 'alt+y' }, true), f.owner(), profile('B pretty'))).toBe(true)
    f.sid = 's1'
    f.canonical = 'a'
    expect(f.prefs.profile).toBe('')
    expect(f.prefs.actions).toBe(APP_SHORTCUTS)
    expect(f.prefs.accept(full({ 'app.help': 'alt+h' }, true), f.owner(), profile('A new'))).toBe(true)
    oldA.resolve(full({ 'app.help': [] }, true))
    await pending
    expect(f.prefs.profile).toBe('A new')
    expect(f.prefs.matches('app.help', key('h', { alt: true }))).toBe(true)
  })

  it('immediately hides previous actions when canonical profile changes during full read', async () => {
    const f = fixture(full({ 'app.help': 'alt+h' }, true))
    await f.prefs.refresh()
    const waiting = Promise.withResolvers<ConfigGetResult>()
    f.gw.handlers.set('config.get', () => waiting.promise)
    const pending = f.prefs.refresh()
    await vi.waitFor(() => expect(f.gw.sent('config.get')).toHaveLength(3))
    f.canonical = 'b'
    expect(f.prefs.profile).toBe('')
    expect(f.prefs.actions).toBe(APP_SHORTCUTS)
    waiting.resolve(full({ 'app.help': [] }, true))
    await pending
    f.gw.handlers.set('config.get', () => full({ 'app.help': 'alt+y' }))
    await f.prefs.refresh()
    expect(f.gw.sent('config.get').at(-1)).toEqual({ key: 'full', session_id: 's1', profile: 'b' })
    expect(f.prefs.matches('app.help', key('y', { alt: true }))).toBe(true)
  })

  it('fails closed without canonical identity or live sid while keeping built-in keys', async () => {
    const f = fixture(full({ 'app.help': 'alt+h' }, true))
    await f.prefs.refresh()
    const count = f.gw.sent('config.get').length
    f.canonical = null
    expect(f.prefs.profile).toBe('')
    expect(f.prefs.actions).toBe(APP_SHORTCUTS)
    await f.prefs.refresh()
    expect(f.gw.sent('config.get')).toHaveLength(count)
    expect(f.prefs.matches('app.help', key('f1'))).toBe(true)
    expect(f.prefs.matches('app.palette', key('k', { alt: true }))).toBe(true)
    f.sid = null
    f.canonical = 'b'
    await f.prefs.refresh()
    expect(f.gw.sent('config.get')).toHaveLength(count)
    f.sid = 's2'
    await f.prefs.refresh()
    expect(f.gw.sent('config.get').slice(count)).toEqual([
      { key: 'full', session_id: 's2', profile: 'b' },
      { key: 'profile', session_id: 's2', profile: 'b' }
    ])
  })

  it('runs actual pinned two-profile gateway direct-dispatch full and identity reads', async () => {
    const { stdout } = await exec('python3', [coreFixture], { cwd: process.cwd(), timeout: 25_000, maxBuffer: 1024 * 1024 })
    const result = record(stdout.trim())
    if (!result) throw new Error('Pinned core fixture emitted no JSON')
    expect(result['pinned']).toBe(true)
    expect(result['ownerHelp']).toBe('alt+h')
    expect(result['fallbackHelp']).toBe('alt+y')
    expect(result['identityScoped']).toBe(true)
    expect(result['bUnchanged']).toBe(true)
  }, 30_000)

  it('preserves built-in shortcuts if the supported config.get full call fails', async () => {
    const f = fixture()
    f.gw.handlers.set('config.get', () => { throw new Error('Method not found') })
    await f.prefs.refresh()
    expect(f.gw.sent('config.get')).toEqual([{ key: 'full', session_id: 's1', profile: 'a' }])
    expect(f.prefs.actions).toEqual(APP_SHORTCUTS)
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('Method not found'))
  })
})
