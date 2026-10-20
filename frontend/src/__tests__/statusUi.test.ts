// The dock's status: the goal and loop line, the reconnect line, the fast bolt and the effort chip,
// through the app on a fake Tern and gateway.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type Key, plain } from '@stencil-hq/tern'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FakeGateway, fakeTern, key, type Reply } from './fakes.js'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))

process.env.HERMES_HOME = mkdtempSync(join(tmpdir(), 'hermes-tern-status-'))

const { App } = await import('../app.js')
const { localCommand } = await import('../commands.js')
const { fastValue, fastTier } = await import('../fast.js')
const { forgetCaps, rememberCaps } = await import('../modelCaps.js')
const { effortText, levelsFor, nextEffort } = await import('../overlays/effort.js')
const { openModelPicker } = await import('../overlays/models.js')

const settle = () => new Promise(resolve => setTimeout(resolve, 5))

function setup(replies: Record<string, Reply> = {}, canonical = true) {
  const gw = new FakeGateway({ canonical, replies })
  const tern = fakeTern({ cols: 100, draws: true })
  /** The last frame's dock. */
  const shown = () => (tern.frame as { dock?: unknown[] } | undefined)?.dock ?? []

  const app = new App(tern.session, gw.client, '1.0.0')
  void app.run()
  app.sid = 's1'

  const press = async (k: Key) => {
    await vi.waitFor(() => expect(tern.reading).toBe(true))
    tern.press(k)
    await settle()
  }

  const emit = (name: string, arg: unknown) => gw.emit(name, arg)
  const sent = (method: string) => gw.sent(method)
  /** The dock as the pane would read it, after the pending render. */
  const dock = async () => {
    await settle()

    return plain({ dock: shown() } as never, 200)
  }

  /** The dock's nodes as JSON, for what plain text leaves out (icons). */
  const raw = async () => {
    await settle()

    return JSON.stringify(shown())
  }

  return { app, dock, emit, press, raw, sent }
}

const goal = { contract: {}, gates: [], max_turns: 10, status: 'active', subgoals: [], title: 'Fix the flaky test', turns_used: 4 }
const control = (over: Record<string, unknown>) => ({ goal: null, heartbeat: null, loop: null, revision: 'r', updated_at: 1, ...over })

afterEach(() => forgetCaps())

describe('App: the goal and loop line', () => {
  it('reads the snapshot when a session is adopted', async () => {
    const { dock, emit, sent } = setup({
      'session.control.read': () => ({ control: control({ goal }) }),
      'session.create': () => ({ info: { model: 'm' }, session_id: 's1' }),
      'setup.status': () => ({ provider_configured: true })
    })

    emit('event', { payload: {}, type: 'gateway.ready' })
    await vi.waitFor(() => expect(sent('session.control.read')).toEqual([{ session_id: 's1' }]))
    expect(await dock()).toContain('Fix the flaky test')
  })

  it('follows session.control.update, and drops the line once nothing stands', async () => {
    const { app, dock, emit } = setup()

    app.automation.adopt('s1')
    emit('event', { payload: { control: control({ goal }) }, session_id: 's1', type: 'session.control.update' })
    expect(await dock()).toMatch(/Goal Fix the flaky test .* 4\/10/)

    emit('event', { payload: { control: control({ goal: { ...goal, status: 'paused' } }) }, session_id: 's1', type: 'session.control.update' })
    expect(await dock()).toContain('Goal paused')

    emit('event', { payload: { control: control({}) }, session_id: 's1', type: 'session.control.update' })
    expect(await dock()).not.toContain('Goal')
  })

  it('ignores another session\'s update', async () => {
    const { app, dock, emit } = setup()

    app.automation.adopt('s1')
    emit('event', { payload: { control: control({ goal }) }, session_id: 's2', type: 'session.control.update' })
    expect(await dock()).not.toContain('Fix the flaky test')
  })

  it('opens the sheet from the keyboard and pauses the goal', async () => {
    const { app, emit, press, sent } = setup({ 'session.control': () => ({ control: control({ goal: { ...goal, status: 'paused' } }), dispatch: {} }) })

    app.automation.adopt('s1')
    emit('event', { payload: { control: control({ goal }) }, session_id: 's1', type: 'session.control.update' })
    await settle()
    await press(key('down'))
    await press(key('enter'))
    expect(app.overlays.at(-1)?.key).toBe('automation:goal')

    await press(key('p', { text: 'p' }))
    expect(sent('session.control')).toEqual([{ action: 'goal.pause', session_id: 's1' }])
    expect(app.automation.goal?.state).toBe('paused')
  })
})

describe('App: reconnecting', () => {
  it('shows one line with the try and its countdown, replaced per try and gone on ready', async () => {
    const { dock, emit } = setup()

    emit('event', { payload: { attempt: 1, delay_ms: 1000 }, type: 'gateway.reconnecting' })
    expect(await dock()).toContain('Reconnecting to Hermes · attempt 1 · next try in')

    emit('event', { payload: { attempt: 2, delay_ms: 2000 }, type: 'gateway.reconnecting' })
    const second = await dock()
    expect(second).toContain('attempt 2')
    expect(second).not.toContain('attempt 1')

    emit('event', { payload: {}, type: 'gateway.ready' })
    expect(await dock()).not.toContain('Reconnecting')
  })
})

describe('App: fast mode', () => {
  it('puts a bolt on the model chip while the session runs fast', async () => {
    expect(fastTier({ fast: true, service_tier: 'priority' })).toBe('fast')
    expect(fastTier({ fast: true, service_tier: 'ultrafast' })).toBe('ultrafast')
    // A tier the route does not apply is not fast.
    expect(fastTier({ fast: false, service_tier: 'priority' })).toBeUndefined()

    const { app, raw } = setup()
    app.info = { model: 'gpt-5' }
    app.changed()
    expect(await raw()).not.toContain('"bolt"')

    app.info = { fast: true, model: 'gpt-5', service_tier: 'priority' }
    app.changed()
    expect(await raw()).toContain('"bolt"')
  })

  it('/fast toggles through config.set and patches the info from the reply', async () => {
    const { app, sent } = setup({ 'config.set': p => ({ key: 'fast', value: p.value === 'toggle' ? 'fast' : 'normal' }) })
    app.info = { model: 'gpt-5' }

    await localCommand('fast')!.run(app, '')
    expect(sent('config.set')).toEqual([{ key: 'fast', session_id: 's1', value: 'toggle' }])
    expect(app.info).toMatchObject({ fast: true, service_tier: 'priority' })

    await localCommand('fast')!.run(app, 'off')
    expect(sent('config.set').at(-1)).toEqual({ key: 'fast', session_id: 's1', value: 'normal' })
    expect(app.info).toMatchObject({ fast: false, service_tier: '' })
  })

  it('says when the route has no fast mode, and takes only its words', async () => {
    const { app } = setup({
      'config.set': () => {
        throw new Error('fast_unavailable')
      }
    })

    await localCommand('fast')!.run(app, 'on')
    expect(app.transcript.entries.at(-1)).toMatchObject({ text: 'This model has no fast mode on its current route.' })
    expect(fastValue('ultrafast')).toBe('ultrafast')
    expect(fastValue('warp')).toBeNull()
  })

  it('the model picker\'s Fast sets the tier after the switch, for a model that has one', async () => {
    const { app, press, sent } = setup({
      'config.set': () => ({ key: 'fast', value: 'fast' }),
      'model.options': () => ({
        model: 'a',
        provider: 'p',
        providers: [{ capabilities: { b: { fast: true, reasoning: true } }, is_current: true, models: ['a', 'b'], name: 'P', slug: 'p' }]
      }),
      'session.mutate': () => ({ model: 'b', status: 'applied' }),
      'session.resume': () => ({ execution_generation: 1, revision: 1 })
    })
    app.info = { model: 'a', reasoning_effort: 'medium' }

    openModelPicker(app)
    await settle()
    await press(key('down'))
    await press(key('f', { ctrl: true }))
    await press(key('enter'))
    await vi.waitFor(() => expect(sent('config.set')).toEqual([{ key: 'fast', session_id: 's1', value: 'fast' }]))
    expect(sent('session.mutate')[0]).toMatchObject({ operation: 'model', payload: { model: 'b', provider: 'p' } })
  })
})

describe('the effort chip and its levels', () => {
  it('shows the default level when none is set, and a clamped level as what the route sends', () => {
    expect(effortText('')).toBe('medium')
    expect(effortText('none')).toBe('off')
    expect(effortText('ultra', 'max')).toBe('ultra→max')
    expect(effortText('high', 'high')).toBe('high')
  })

  it('offers no levels without reasoning, and no off where it cannot be turned off', () => {
    expect(levelsFor({ fast: false, reasoning: false })).toEqual([])
    expect(levelsFor({ can_disable_reasoning: false, fast: false, reasoning: true }).map(l => l.id)).not.toContain('none')
    expect(levelsFor(undefined).map(l => l.id)).toContain('ultra')
  })

  it('steps up the cycle from any level, the default reading as medium', () => {
    expect(nextEffort('')).toBe('high')
    expect(nextEffort('xhigh')).toBe('none')
    expect(nextEffort('minimal')).toBe('low')
    expect(nextEffort('ultra')).toBe('none')
    expect(nextEffort('xhigh', { can_disable_reasoning: false, fast: false, reasoning: true })).toBe('low')
    expect(nextEffort('low', { fast: false, reasoning: false })).toBeUndefined()
  })

  it('is hidden for a model without reasoning, muted at the default', async () => {
    const { app, dock } = setup()
    app.info = { model: 'plain-model', provider: 'p', reasoning_effort: '' }
    app.changed()
    expect(await dock()).toContain('medium')

    rememberCaps([{ capabilities: { 'plain-model': { fast: false, reasoning: false } }, models: ['plain-model'], name: 'P', slug: 'p' } as never])
    app.changed()
    expect(await dock()).not.toContain('medium')
  })
})

describe('App: setting the effort', () => {
  const mutation = (fail = false): Record<string, Reply> => ({
    'session.mutate': () => {
      if (fail) {
        throw new Error('stale_revision')
      }

      return { status: 'applied' }
    },
    'session.resume': () => ({ execution_generation: 2, revision: 7 })
  })

  it('sends the session level as the reasoning mutation on the shared gateway', async () => {
    const { app, sent } = setup(mutation())
    app.info = { model: 'm', reasoning_effort: 'low' }

    await app.setEffort('high', 'session')
    expect(sent('session.mutate')).toEqual([
      expect.objectContaining({ expected_generation: 2, expected_revision: 7, operation: 'reasoning', payload: { effort: 'high' }, session_id: 's1' })
    ])
    expect(sent('config.set')).toEqual([])
    expect(app.info?.reasoning_effort).toBe('high')
  })

  it('keeps config.set scope=global for Save as default, and config.set on a private gateway', async () => {
    const shared = setup(mutation())
    await shared.app.setEffort('max', 'global')
    expect(shared.sent('config.set')).toEqual([{ key: 'reasoning', scope: 'global', session_id: 's1', value: 'max' }])
    expect(shared.sent('session.mutate')).toEqual([])

    const own = setup({}, false)
    await own.app.setEffort('low', 'session')
    expect(own.sent('config.set')).toEqual([{ key: 'reasoning', scope: 'session', session_id: 's1', value: 'low' }])
  })

  it('rolls the chip back when the change is refused', async () => {
    const { app } = setup(mutation(true))
    app.info = { model: 'm', reasoning_effort: 'low', reasoning_effort_wire: 'low' }

    await app.setEffort('high', 'session')
    expect(app.info).toMatchObject({ reasoning_effort: 'low', reasoning_effort_wire: 'low' })
    expect(app.transcript.entries.at(-1)).toMatchObject({ text: expect.stringContaining('stale_revision'), tone: 'error' })
  })

  it('/reasoning <level> sets it the same way; its other forms stay the backend\'s', async () => {
    const { app, sent } = setup(mutation())
    app.info = { model: 'm' }

    await localCommand('reasoning')!.run(app, 'ultra')
    await settle()
    expect(sent('session.mutate')[0]).toMatchObject({ operation: 'reasoning', payload: { effort: 'ultra' } })
    expect(localCommand('reasoning')!.run(app, 'show')).toBe(false)
  })
})
