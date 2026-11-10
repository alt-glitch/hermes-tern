import type { ModelOptionsResult } from '@hermes/shared/gateway-events'
import { describe, expect, it, vi } from 'vitest'

import type { ModelsHost } from '../../overlays/models.js'
import type { Overlay } from '../../overlays/overlay.js'
import { liveSessionId } from '../../core/ids.js'
import { SessionState } from '../../session/state.js'
import { Transcript } from '../../transcript/store.js'
import { FakeGateway, key } from '../../__tests__/fakes.js'

import { activeModel, availableModels, cycleModel, cycleTarget } from '../model-cycle.js'
import { modelRecents } from '../model-recents.js'

/** Pinned model.options: providers, model, provider (no pending_* or safe_inventory). */
function options(models = ['alpha', 'beta', 'gamma']): ModelOptionsResult {
  return {
    model: 'alpha',
    provider: 'fixture',
    providers: [{ authenticated: true, is_current: true, models, name: 'Fixture', slug: 'fixture' }]
  }
}

function fixture(models = ['alpha', 'beta', 'gamma'], expensive = false) {
  let selected = 'alpha'
  const gw = new FakeGateway()
  const state = new SessionState(() => {})
  state.ref = { live: liveSessionId('s1'), stored: null }
  state.info = { model: 'alpha', provider: 'fixture' }
  const transcript = new Transcript()
  const notice = vi.spyOn(transcript, 'notice')
  const overlays: Overlay[] = []
  const changed = vi.fn()
  gw.handlers.set('model.options', () => ({ ...options(models), model: selected }))
  // Canonical picker authority: read a revision, submit a session.mutate CAS,
  // replay the server's one-time confirmation token on explicit user acceptance.
  gw.handlers.set('session.resume', () => ({ revision: 7, execution_generation: 3 }))
  gw.handlers.set('session.mutate', p => {
    const payload = p['payload']

    if (!payload || typeof payload !== 'object' || !('model' in payload) || typeof payload.model !== 'string') {
      throw new Error('Invalid canonical model mutation')
    }

    if (expensive && (!('confirm' in payload) || payload.confirm !== 'once-7')) {
      return { status: 'confirmation_required', confirm: 'once-7', confirm_message: 'Expensive fixture' }
    }

    selected = payload.model

    return { status: 'applied', model: selected }
  })
  const host: ModelsHost = {
    gw: gw.client, session: state, transcript, changed,
    open: (overlay: Overlay) => void overlays.push(overlay),
    close: (overlay: Overlay) => void overlays.splice(overlays.indexOf(overlay), 1),
    setEffort: async () => undefined
  }

  return { gw, host, state, notice, overlays, changed }
}

describe('pinned model inventory and session-owned cycling', () => {
  it('filters explicitly unavailable routes and reads pending intent from session.info', () => {
    const opts: ModelOptionsResult = {
      ...options(),
      providers: [
        { name: 'Fixture', slug: 'fixture', models: ['alpha', 'beta', 'gamma'], authenticated: true, unavailable_models: ['gamma'], is_current: true },
        { name: 'Not configured', slug: 'absent', models: ['x'], authenticated: false }
      ]
    }
    expect(availableModels(opts)).toEqual([{ model: 'alpha', provider: 'fixture' }, { model: 'beta', provider: 'fixture' }])
    expect(activeModel(opts, { model: 'beta', provider: 'fixture' })).toEqual({ model: 'beta', provider: 'fixture' })
    expect(activeModel(opts, { model: '', provider: '' })).toEqual({ model: 'alpha', provider: 'fixture' })
  })

  it('cycles by inventory then recents and resets recents on session change', async () => {
    const f = fixture()
    await cycleModel(f.host, 1)
    expect(f.state.info?.model).toBe('beta')
    await cycleModel(f.host, 1)
    expect(f.state.info?.model).toBe('gamma')
    expect(modelRecents(f.state).list('s1').map(row => row.model)).toEqual(['beta', 'gamma'])
    await cycleModel(f.host, -1)
    expect(f.state.info?.model).toBe('beta')
    expect(f.gw.sent('model.options')).toEqual([
      { session_id: 's1' }, { session_id: 's1' }, { session_id: 's1' }
    ])
    expect(f.gw.sent('session.mutate').map(p => [p['session_id'], p['payload']])).toEqual([
      ['s1', { model: 'beta', provider: 'fixture' }],
      ['s1', { model: 'gamma', provider: 'fixture' }],
      ['s1', { model: 'beta', provider: 'fixture' }]
    ])
    expect(f.gw.sent('config.set')).toEqual([])
    f.state.ref = { live: liveSessionId('s2'), stored: null }
    expect(modelRecents(f.state).list('s2')).toEqual([])
  })

  it('uses an owner-reported pending route, not model.options invented fields', async () => {
    const f = fixture()
    // This is the shape pinned _session_info emits when a mid-turn pick is deferred.
    f.state.info = { model: 'beta', provider: 'fixture' }
    await cycleModel(f.host, 1)
    expect(f.gw.sent('session.mutate')[0]).toMatchObject({ session_id: 's1', operation: 'model', payload: { model: 'gamma', provider: 'fixture' } })
    expect(f.gw.sent('config.set')).toEqual([])
    expect(f.state.info?.model).toBe('gamma')
  })

  it('requires explicit keyboard confirmation through the owning gateway', async () => {
    const f = fixture(['alpha', 'beta'], true)
    await cycleModel(f.host, 1)
    expect(f.state.info?.model).toBe('alpha')
    expect(f.overlays[0]?.key).toBe('confirm:Switch to an expensive model?')
    const confirm = f.overlays[0]

    if (!confirm) throw new Error('Missing model confirmation')

    confirm.onKey(key('y'))
    await vi.waitFor(() => expect(f.state.info?.model).toBe('beta'))
    expect(f.gw.sent('session.mutate').map(p => p['payload'])).toEqual([
      { model: 'beta', provider: 'fixture' },
      { model: 'beta', provider: 'fixture', confirm: 'once-7' }
    ])
    expect(f.gw.sent('config.set')).toEqual([])
  })

  it('honors canonical CAS authority and replays only its issued confirmation token', async () => {
    const f = fixture(['alpha', 'beta'], true)
    await cycleModel(f.host, 1)
    expect(f.state.info?.model).toBe('alpha')
    expect(f.overlays[0]?.key).toBe('confirm:Switch to an expensive model?')
    expect(f.gw.sent('config.set')).toEqual([])
    expect(f.gw.sent('session.mutate')).toHaveLength(1)
    const confirm = f.overlays[0]

    if (!confirm) throw new Error('Missing canonical confirmation')

    confirm.onKey(key('enter'))
    await vi.waitFor(() => expect(f.state.info?.model).toBe('beta'))
    expect(f.gw.sent('session.resume')).toEqual([{ session_id: 's1' }, { session_id: 's1' }])
    const mutations = f.gw.sent('session.mutate')
    expect(mutations).toHaveLength(2)
    expect(mutations[0]).toMatchObject({
      session_id: 's1', operation: 'model', expected_revision: 7, expected_generation: 3,
      payload: { model: 'beta', provider: 'fixture' }
    })
    expect(mutations[1]).toMatchObject({
      session_id: 's1', operation: 'model', expected_revision: 7, expected_generation: 3,
      payload: { model: 'beta', provider: 'fixture', confirm: 'once-7' }
    })
    expect(f.gw.sent('config.set')).toEqual([])
  })

  it('drops an old inventory reply after a session replacement, even A-B-A', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<ModelOptionsResult>()
    f.gw.handlers.set('model.options', () => pending.promise)
    const running = cycleModel(f.host, 1)
    f.state.ref = { live: liveSessionId('s2'), stored: null }
    f.state.ref = { live: liveSessionId('s1'), stored: null }
    pending.resolve(options())
    await running
    expect(f.gw.sent('config.set')).toEqual([])
    expect(f.gw.sent('session.mutate')).toEqual([])
  })

  it('cannot confirm an expensive model for a replaced session', async () => {
    const f = fixture(['alpha', 'beta'], true)
    await cycleModel(f.host, 1)
    const confirm = f.overlays[0]

    if (!confirm) throw new Error('Missing confirmation before session replacement')

    f.state.ref = { live: liveSessionId('s2'), stored: null }
    confirm.onKey(key('y'))
    await Promise.resolve()
    expect(f.gw.sent('session.mutate')).toHaveLength(1)
    expect(f.gw.sent('session.resume')).toHaveLength(1)
    expect(f.gw.sent('config.set')).toEqual([])
  })

  it('respects authorized recent rows and refuses one-model inventory', () => {
    const all = [
      { model: 'alpha', provider: 'p' },
      { model: 'beta', provider: 'p' },
      { model: 'gamma', provider: 'p' }
    ]
    const alpha = all[0]
    const gamma = all[2]

    if (!alpha || !gamma) throw new Error('Fixture requires three models')

    expect(cycleTarget(all, [alpha, gamma], gamma, 1)).toEqual(alpha)
    expect(cycleTarget(all.slice(0, 2), [gamma, alpha], alpha, 1)).toEqual(all[1])
    expect(cycleTarget(all, [], { model: 'unknown', provider: 'p' }, -1)).toEqual(gamma)
    expect(cycleTarget([alpha], [], alpha, 1)).toBeNull()
  })
})
