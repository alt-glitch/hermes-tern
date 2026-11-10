import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { Surface, View, type NodeJson } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@hermes/shared/gateway-types'
import { localCommand } from '../commands/local.js'
import { preference, preferenceValue, PROFILE_PREFERENCES } from '../preferences/contracts.js'
import { readProfile, writeProfile } from '../preferences/transactions.js'
import { openSettings } from '../overlays/settings.js'
import { openModelHub } from '../overlays/modelHub.js'
import type { Overlay } from '../overlays/overlay.js'
import { record } from '../wire/json.js'

import { settle, setup } from './appSetup.js'
import { key, must, stub, tree } from './fakes.js'
import type { GatewayClient } from '@hermes/shared/gateway-client'

const exec = promisify(execFile)
const coreFixture = fileURLToPath(new URL('./fixtures/native-settings-profile-core.py', import.meta.url))

function ownedSetup(replies: Parameters<typeof setup>[0]) {
  const running = setup(replies)
  running.app.session.info = stub<SessionInfo>({ profile_name: 'work' })
  return running
}

function nativeRoot(overlay: Overlay): string {
  const key = tree(overlay.node(`layer.${overlay.key}`)).p?.['key']
  if (typeof key !== 'string') throw new Error('SDK native root key missing')
  return key
}

function renderWithSdk(overlay: Overlay): View {
  const layer = [overlay.node(`layer.${overlay.key}`)]
  const surface = new Surface({ send: vi.fn(), credits: () => 1, dropped: () => {} }, 'hermes', { mode: 'inline' })
  surface.render({ layer })
  return View.from({ layer })
}

vi.mock('@hermes/shared/prompt-history', () => ({ append: () => undefined, load: () => [] }))

const starting = () => new Map<string, string>(PROFILE_PREFERENCES.map(field => [field.key, field.options?.[0] ?? 'default'] satisfies [string, string]))

function prefsJson(node: NodeJson): Record<string, unknown> {
  expect(node.k).toBe('prefs')
  return node.p ?? {}
}

function ids(p: Record<string, unknown>): string[] {
  const sections = p['sections']

  if (!Array.isArray(sections)) {
    throw new Error('Tern prefs sections did not render')
  }

  return sections.flatMap(s => {
    const section = record(s)
    const rows = section?.['rows']

    return Array.isArray(rows) ? rows.flatMap(r => {
      const id = record(r)?.['id']
      return typeof id === 'string' ? [id] : []
    }) : []
  })
}

function fixture() {
  const values = starting()
  const replies = {
    'config.get': (params: Record<string, unknown>) => ({ value: values.get(String(params['key'])) }),
    'config.set': (params: Record<string, unknown>) => {
      const field = String(params['key'])
      const value = String(params['value'])
      values.set(field, value)
      return { key: field, value }
    },
    'model.options': () => ({
      model: 'model-one',
      provider: 'safe-provider',
      providers: [
        { slug: 'safe-provider', name: 'Safe provider', authenticated: true, models: ['model-one', 'model-two'], api_url: 'https://secret.invalid/?credential=must-not-render' },
        { slug: 'locked-provider', name: 'Locked provider', authenticated: false, models: [] }
      ]
    })
  }

  return { replies, values }
}

describe('native Settings registrations and real App rendering', () => {
  it('registers /settings, /prefs and /models without replacing /model', () => {
    expect(localCommand('settings')?.name).toBe('settings')
    expect(localCommand('prefs')?.name).toBe('prefs')
    expect(localCommand('models')?.name).toBe('models')
    expect(localCommand('model')?.name).toBe('model')
  })

  it('does no settings/model-hub read on closed startup or ordinary frames; paints native schema-supported field types on open', async () => {
    const { replies } = fixture()
    const { app, press, sent, type } = ownedSetup(replies)
    const config = () => sent('config.get').filter(p => PROFILE_PREFERENCES.some(f => f.key === p['key']))

    expect(config()).toEqual([])
    expect(sent('model.options')).toEqual([])
    await type('/settings')
    await press(key('enter'))
    await vi.waitFor(() => expect(config()).toHaveLength(PROFILE_PREFERENCES.length))
    expect(sent('config.get').some(p => p['key'] === 'full' && p['source'] === 'settings')).toBe(false)
    await settle()
    expect(sent('settings.get')).toEqual([])
    expect(sent('settings.set')).toEqual([])

    const overlay = must(app.overlays.find(o => o.key === 'settings'))
    const session = prefsJson(tree(overlay.node('layer.settings')))
    expect(ids(session)).toContain('session.model')
    expect(ids(session)).toContain('session.effort')
    expect(ids(session)).toContain('session.hub')
    expect(session['pages']).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'profile.Agent' }),
      expect.objectContaining({ id: 'profile.Safety' }),
      expect.objectContaining({ id: 'profile.Display' })
    ]))

    await press(key('tab'))
    const agent = prefsJson(tree(overlay.node('layer.settings')))
    expect(ids(agent)).toContain('busy')
    expect(JSON.stringify(agent)).toContain('"k":"choice"')

    await press(key('tab'))
    const safety = prefsJson(tree(overlay.node('layer.settings')))
    expect(ids(safety)).toContain('approvals.mode')
    expect(JSON.stringify(safety)).toContain('manual')

    await press(key('tab'))
    const display = prefsJson(tree(overlay.node('layer.settings')))
    expect(ids(display)).toEqual(expect.arrayContaining(['details_mode', 'thinking_mode', 'theme', 'density', 'focus', 'skin']))
    expect(JSON.stringify(display)).toContain('"k":"switch"')
    expect(JSON.stringify(display)).toContain('"k":"text"')
  })

  it('writes only the active profile key, confirms readback, preserves the main composer caret/undo and its paste markers', async () => {
    const { replies, values } = fixture()
    const { app, press, sent } = ownedSetup(replies)
    app.stores.composer.set('Café 🧩 literal', { cursor: 4 })
    app.stores.composer.key(key('paste', { text: '!echo do-not-execute' }))
    const before = { text: app.stores.composer.text, cursor: app.stores.composer.cursor, pasted: [...app.stores.composer.pasted] }

    openSettings(app)
    await vi.waitFor(() => expect(sent('config.get').filter(p => p['key'] === 'busy')).toHaveLength(1))
    await settle()
    await press(key('tab'))
    await press(key('enter'))
    await press(key('down'))
    await press(key('enter'))
    await vi.waitFor(() => expect(sent('config.set')).toEqual([{ key: 'busy', value: 'steer', session_id: 's1', profile: 'work' }]))
    await vi.waitFor(() => expect(values.get('busy')).toBe('steer'))
    expect(app.stores.composer.text).toBe(before.text)
    expect(app.stores.composer.cursor).toBe(before.cursor)
    expect(app.stores.composer.pasted).toEqual(before.pasted)
    await press(key('escape'))
    expect(app.overlays.some(item => item.key === 'settings')).toBe(false)
    app.stores.composer.undo()
    expect(app.stores.composer.text).toBe('Café 🧩 literal')
    expect(app.stores.composer.pasted).toEqual([])
    app.stores.composer.redo()
    expect(app.stores.composer.text).toBe(before.text)
    expect(app.stores.composer.cursor).toBe(before.cursor)
    expect(app.stores.composer.pasted).toEqual(before.pasted)
    expect(sent('shell.exec')).toEqual([])
    expect(sent('model.hub.set')).toEqual([])
  })

  it('does not treat Enter or Escape as approval confirmation, even for an explicit security-policy change', async () => {
    const { replies, values } = fixture()
    const { app, press, sent } = ownedSetup(replies)

    openSettings(app)
    await vi.waitFor(() => expect(sent('config.get').filter(p => p['key'] === 'approvals.mode')).toHaveLength(1))
    await settle()
    await press(key('tab'))
    await press(key('tab'))
    await press(key('enter'))
    await press(key('down'))
    await press(key('enter'))
    const confirm = must(app.overlays.find(o => o.key === 'settings'))
    expect(tree(confirm.node('layer.settings')).k).toBe('overlay')
    expect(JSON.stringify(tree(confirm.node('layer.settings')))).toContain('Confirm profile policy change')
    await press(key('enter'))
    expect(sent('config.set')).toEqual([])
    expect(values.get('approvals.mode')).toBe('manual')
  })

  it('drops late overlay reads after closing, replacing or switching sessions', async () => {
    const first = Promise.withResolvers<{ value: string }>()
    const values = starting()
    let busyReads = 0
    const { app, press, sent } = ownedSetup({
      'config.get': params => {
        if (params['key'] === 'busy' && ++busyReads === 1) {
          return first.promise
        }
        return { value: values.get(String(params['key'])) }
      }
    })

    openSettings(app)
    await vi.waitFor(() => expect(sent('config.get').filter(p => p['key'] === 'busy')).toHaveLength(1))
    const old = must(app.overlays.find(o => o.key === 'settings'))
    await press(key('escape'))
    expect(app.overlays.includes(old)).toBe(false)
    first.resolve({ value: 'steer' })
    await settle()
    expect(sent('config.set')).toEqual([])

    openSettings(app)
    await vi.waitFor(() => expect(sent('config.get').filter(p => p['key'] === 'busy')).toHaveLength(2))
    await settle()
    expect(tree(must(app.overlays.find(o => o.key === 'settings')).node('layer.settings')).k).toBe('prefs')
  })

  it('uses the live gateway provider inventory with no role/fallback RPCs or leaked endpoints', async () => {
    const { replies } = fixture()
    const { app, sent } = ownedSetup(replies)

    expect(sent('model.options')).toEqual([])
    openModelHub(app)
    await vi.waitFor(() => expect(sent('model.options')).toEqual([{ session_id: 's1', profile: 'work' }]))
    const hub = must(app.overlays.find(o => o.key === 'model-hub'))
    const rendered = JSON.stringify(tree(hub.node('layer.model-hub')))
    expect(rendered).toContain('Safe provider')
    expect(rendered).toContain('Locked provider')
    expect(rendered).toContain('Auxiliary role assignments')
    expect(rendered).not.toContain('credential=must-not-render')
    expect(sent('model.hub.get')).toEqual([])
    expect(sent('model.hub.set')).toEqual([])
    expect(sent('config.set')).toEqual([])
  })
})

describe('pinned Hermes Settings transaction and isolation contract', () => {
  const gateway = (handler: (method: string, params: Record<string, unknown>) => Promise<unknown> | unknown) =>
    stub<GatewayClient>({ request: handler })

  it('never requests full config or unknown fields and uses the session profile on every supported read', async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = []
    const values = starting()
    const gw = gateway((method, params) => {
      calls.push({ method, params })
      return { value: values.get(String(params['key'])) }
    })
    const rows = await readProfile({ active: () => true, gw, sid: 'profile-a-session', profile: 'work' })
    expect(rows.map(row => row.field.key)).toEqual(PROFILE_PREFERENCES.map(field => field.key))
    expect(calls).toHaveLength(PROFILE_PREFERENCES.length)
    expect(calls.every(call => call.method === 'config.get' && call.params['session_id'] === 'profile-a-session' && call.params['profile'] === 'work' && call.params['key'] !== 'full')).toBe(true)
  })

  it('rejects a conflicting owner read before write instead of bumping a silent revision', async () => {
    const calls: string[] = []
    const gw = gateway((method, params) => {
      calls.push(method)
      return { value: params['key'] === 'busy' ? 'interrupt' : '' }
    })
    const field = must(preference('busy'))
    await expect(writeProfile({ active: () => true, gw, sid: 's1', profile: 'work' }, field, 'steer', 'queue')).rejects.toThrow('Profile changed')
    expect(calls).toEqual(['config.get'])
  })

  it('never calls config.set after the sheet became stale while the canonical read was in flight', async () => {
    const first = Promise.withResolvers<unknown>()
    const calls: string[] = []
    let alive = true
    const gw = gateway((method) => { calls.push(method); return first.promise })
    const write = writeProfile({ active: () => alive, gw, sid: 's1', profile: 'work' }, must(preference('busy')), 'steer', 'queue')
    await vi.waitFor(() => expect(calls).toEqual(['config.get']))
    alive = false
    first.resolve({ value: 'queue' })
    await expect(write).rejects.toThrow('Settings session changed')
    expect(calls).toEqual(['config.get'])
  })

  it('reports contradictory ACK/readback and does not present a success receipt', async () => {
    let gets = 0
    const gw = gateway((method, params) => {
      if (method === 'config.get') {
        return { value: ++gets === 1 ? 'queue' : 'interrupt' }
      }
      return { key: params['key'], value: params['value'] }
    })
    await expect(writeProfile({ active: () => true, gw, sid: 's1', profile: 'work' }, must(preference('busy')), 'steer', 'queue')).rejects.toThrow('Canonical readback differs')
  })

  it('rejects undeclared setting values and cannot use a generic secret/role/fallback key', async () => {
    expect(() => preferenceValue(must(preference('approvals.mode')), 'administrator')).toThrow()
    expect(preference('providers.openai.api_key')).toBeUndefined()
    expect(preference('agent.fallbacks')).toBeUndefined()
    expect(preference('auxiliary.vision')).toBeUndefined()
  })
})


describe('SDK Settings instance IDs and scoped profile transaction regressions', () => {
  it('uses a fresh native root for every Settings and Model Hub opening; logical keys stay stable', async () => {
    const f = fixture()
    const { app, sent } = ownedSetup(f.replies)
    openSettings(app)
    await vi.waitFor(() => expect(sent('config.get').some(p => p['key'] === 'skin')).toBe(true))
    const first = must(app.overlays.find(o => o.key === 'settings'))
    const a = nativeRoot(first)
    expect(renderWithSdk(first).find('layer.' + a)).toBeDefined()
    expect(nativeRoot(first)).toBe(a)
    app.close(first)

    openSettings(app)
    const second = must(app.overlays.find(o => o.key === 'settings'))
    const b = nativeRoot(second)
    expect(b).not.toBe(a)
    expect(renderWithSdk(second).find('layer.' + b)).toBeDefined()
    expect(second.key).toBe(first.key)
    app.close(second)

    openModelHub(app)
    const hubA = must(app.overlays.find(o => o.key === 'model-hub'))
    const hubRootA = nativeRoot(hubA)
    expect(renderWithSdk(hubA).find('layer.' + hubRootA)).toBeDefined()
    app.close(hubA)
    openModelHub(app)
    const hubB = must(app.overlays.find(o => o.key === 'model-hub'))
    expect(nativeRoot(hubB)).not.toBe(hubRootA)
    expect(renderWithSdk(hubB).find('layer.' + nativeRoot(hubB))).toBeDefined()
  })

  it('dispatches actual SDK A IDs only against the latest B tree, never B callbacks', async () => {
    const { replies, values } = fixture()
    const { app, sent } = ownedSetup(replies)
    const send = vi.fn()
    const surface = new Surface({ send, credits: () => 1, dropped: () => {} }, 'hermes', { mode: 'inline' })

    openSettings(app)
    await vi.waitFor(() => expect(sent('config.get').filter(p => p['key'] === 'skin')).toHaveLength(1))
    await settle()
    const oldSheet = must(app.overlays.find(o => o.key === 'settings'))
    const oldId = 'layer.' + nativeRoot(oldSheet)
    surface.render({ layer: [oldSheet.node('layer.settings')] })
    expect(View.from({ layer: [oldSheet.node('layer.settings')] }).find(oldId)).toBeDefined()

    app.close(oldSheet)
    openSettings(app)
    await vi.waitFor(() => expect(sent('config.get').filter(p => p['key'] === 'skin')).toHaveLength(2))
    await settle()
    const newSheet = must(app.overlays.find(o => o.key === 'settings'))
    const newId = 'layer.' + nativeRoot(newSheet)
    surface.render({ layer: [newSheet.node('layer.settings')] })

    // Real SDK resolves incoming terminal IDs against #latest after render(), not
    // against whichever handler was originally attached before the last paint.
    expect(surface.dispatch({
      ev: 'change', sf: 'hermes', id: oldId, item: 'busy', value: 'interrupt', raw: {}
    })).toBeUndefined()
    expect(surface.dispatch({
      ev: 'action', sf: 'hermes', id: oldId, act: 'page',
      value: 'profile.Safety', raw: {}
    })).toBeUndefined()
    expect(sent('config.set')).toEqual([])
    expect(values.get('busy')).toBe('queue')

    const current = surface.dispatch({
      ev: 'change', sf: 'hermes', id: newId, item: 'busy', value: 'steer', raw: {}
    })
    expect(current).toBeDefined()
    await current?.()
    await vi.waitFor(() => expect(values.get('busy')).toBe('steer'))
    expect(sent('config.set')).toEqual([{
      key: 'busy', value: 'steer', session_id: 's1', profile: 'work'
    }])
    expect(send).toHaveBeenCalled()
  })

  it('fails closed without canonical session.info profile and sends no profile RPC', async () => {
    const { app, sent } = setup(fixture().replies)
    openSettings(app)
    openModelHub(app)
    expect(app.overlays.some(item => item.key === 'settings' || item.key === 'model-hub')).toBe(false)
    expect(sent('config.get')).toEqual([])
    expect(sent('config.set')).toEqual([])
    expect(sent('model.options')).toEqual([])
    const gw = stub<GatewayClient>({ request: vi.fn() })
    await expect(readProfile({ active: () => true, gw, sid: 's1', profile: '' })).rejects.toThrow('canonical owner')
  })

  it('displays a current hidden detail word, writes another valid word, and retains hidden after selecting it again', async () => {
    const f = fixture()
    f.values.set('details_mode', 'hidden')
    const { app, press, sent } = ownedSetup(f.replies)
    openSettings(app)
    await vi.waitFor(() => expect(sent('config.get').some(p => p['key'] === 'skin')).toBe(true))
    await settle()
    for (let i = 0; i < 3; i++) await press(key('tab'))
    const sheet = must(app.overlays.find(o => o.key === 'settings'))
    const display = prefsJson(tree(sheet.node('layer.settings')))
    const sections = display['sections']
    if (!Array.isArray(sections)) throw new Error('No Display section')
    const rows = sections.flatMap(section => {
      const sectionRow = record(section)
      return Array.isArray(sectionRow?.['rows']) ? sectionRow['rows'] : []
    })
    const details = rows.map(row => record(row)).find(row => row?.['id'] === 'details_mode')
    expect(record(details?.['control'])?.['value']).toBe('hidden')
    expect(JSON.stringify(details)).toContain('"value":"hidden"')
    await press(key('enter'))
    await press(key('down'))
    await press(key('enter'))
    await vi.waitFor(() => expect(f.values.get('details_mode')).toBe('collapsed'))
    await settle()
    await press(key('enter'))
    await press(key('up'))
    await press(key('enter'))
    await vi.waitFor(() => expect(f.values.get('details_mode')).toBe('hidden'))
    expect(sent('config.set').filter(p => p['key'] === 'details_mode')).toEqual([
      { key: 'details_mode', value: 'collapsed', session_id: 's1', profile: 'work' },
      { key: 'details_mode', value: 'hidden', session_id: 's1', profile: 'work' }
    ])
  })

  it('never silently retargets B after A runtime is reaped during a transaction', async () => {
    const profiles = new Map([['A', 'queue'], ['B', 'interrupt']])
    let held = true
    const calls: Record<string, unknown>[] = []
    const gw = stub<GatewayClient>({
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, ...params })
        const owner = String(params['profile'] ?? (held && params['session_id'] === 'reaped-A' ? 'A' : 'B'))
        if (method === 'config.get') {
          const value = profiles.get(owner)
          held = false
          return { value }
        }
        const value = String(params['value'])
        profiles.set(owner, value)
        return { key: params['key'], value }
      }
    })
    const receipt = await writeProfile(
      { active: () => true, gw, sid: 'reaped-A', profile: 'A' },
      must(preference('busy')), 'steer', 'queue'
    )
    expect(receipt.value).toBe('steer')
    expect(profiles.get('A')).toBe('steer')
    expect(profiles.get('B')).toBe('interrupt')
    expect(calls.map(c => [c['method'], c['profile'], c['session_id']])).toEqual([
      ['config.get', 'A', 'reaped-A'],
      ['config.set', 'A', 'reaped-A'],
      ['config.get', 'A', 'reaped-A']
    ])
  })

  it('invokes the actual pinned direct-dispatch config.get/set profile contract in an isolated core', async () => {
    const { stdout } = await exec('python3', [coreFixture], { cwd: process.cwd(), timeout: 25_000, maxBuffer: 1024 * 1024 })
    const result = record(stdout.trim())
    if (!result) throw new Error('Pinned core fixture did not emit JSON')
    expect(result['pinned']).toBe(true)
    expect(result['ownerRead']).toBe('queue')
    expect(result['fallbackRead']).toBe('interrupt')
    expect(result['readback']).toBe('steer')
    expect(result['a']).toBe('steer')
    expect(result['b']).toBe('interrupt')
    expect(result['launch']).toBe('queue')
  }, 30_000)
})
