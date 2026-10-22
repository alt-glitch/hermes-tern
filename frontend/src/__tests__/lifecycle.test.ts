import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readLaunchEnv } from '../config/env.js'
import { storedSessionId } from '../core/ids.js'
import { record } from '../wire/json.js'

import { FakeGateway, fakeTern, given, key, must, stubOverlay } from './fakes.js'

process.env['HERMES_HOME'] = mkdtempSync(join(tmpdir(), 'hermes-tern-lifecycle-'))

// The picker reads state.db; here it lists one other session.
vi.mock('../hermes/sessionIndex.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../hermes/sessionIndex.js')>()),
  storedSessions: () => [
    {
      branch: '', cwd: '', id: 'gone', lastActive: Date.now(), messages: 2, model: '', pinned: false,
      preview: 'an old chat', repoRoot: '', source: 'tui', startedAt: Date.now(), title: 'Old chat'
    }
  ]
}))

const { App } = await import('../app/chat.js')
const { openSessionPicker } = await import('../overlays/sessions.js')

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

async function started(gw: FakeGateway) {
  const app = new App(fakeTern().session, gw.client, '')
  void app.run()
  gw.event({ type: 'gateway.ready', payload: {} })
  await flush()
  await flush()

  return app
}

const notices = (app: InstanceType<typeof App>) =>
  app.transcript.entries.flatMap(e => (e.kind === 'notice' ? [e.text] : []))

let gw: FakeGateway
let created = 0

beforeEach(() => {
  created = 0
  gw = new FakeGateway()
  gw.handlers.set('setup.status', () => ({ provider_configured: true }))
  gw.handlers.set('session.create', () => {
    created++

    return { info: { stored_session_id: `s${created}` }, session_id: `s${created}`, subscription_id: `sub${created}` }
  })
  gw.handlers.set('session.resume', p => ({
    execution_generation: 1,
    info: { stored_session_id: p['session_id'] },
    revision: 1,
    running: false,
    session_id: p['session_id'],
    subscription_id: `sub-${p['session_id']}`
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('session lifecycle', () => {
  it('starts a session on the first gateway.ready', async () => {
    const app = await started(gw)

    expect(app.session.ref.live).toBe('s1')
  })

  it("the launcher's --image waits for the first session, then goes with the startup query", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-tern-startup-'))
    writeFileSync(join(dir, 'shot.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]))
    gw.handlers.set('image.attach_bytes', () => ({ path: '/uploads/1.png' }))
    const app = new App(fakeTern().session, gw.client, '', { launch: readLaunchEnv({ HERMES_TUI_IMAGE: 'shot.png' }, dir) })
    void app.run()
    expect(app.stores.queue.held).toEqual([{ images: [], kind: 'app', text: 'What do you see in this image?' }])

    gw.event({ type: 'gateway.ready', payload: {} })
    await vi.waitFor(() => expect(gw.methods('prompt.submit')).toHaveLength(1))

    expect(gw.sent('image.attach_bytes').map(p => p['session_id'])).toEqual(['s1'])
    expect(gw.sent('prompt.submit')[0]).toMatchObject({ attachments: [{ mime: 'image/png', path: '/uploads/1.png' }], text: 'What do you see in this image?' })
    expect(app.stores.queue.held).toEqual([])
  })

  it('reloads the shown session on a replay gap, with a fresh subscription and its turn state', async () => {
    const app = await started(gw)
    given.busy(app.stores, { label: 'Working…', since: {}, startedAt: Date.now() })
    gw.handlers.set('session.resume', p => ({ running: false, session_id: p['session_id'], subscription_id: 'sub-fresh' }))

    gw.event({ payload: { latest_seq: 9 }, session_id: 'other', type: 'session.replay_gap' })
    await flush()
    expect(gw.methods('session.resume')).toHaveLength(0)

    gw.event({ payload: { latest_seq: 9 }, session_id: 's1', type: 'session.replay_gap' })
    await flush()
    await flush()

    expect(gw.methods('session.resume').map(c => c.params['session_id'])).toEqual(['s1'])
    expect(app.stores.activity.busy).toBeNull()
    expect(notices(app).at(-1)).toMatch(/fell behind/)
  })

  it('shows a refused resume from the picker as a notice, not an unhandled rejection', async () => {
    const app = await started(gw)
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    gw.handlers.set('session.resume', () => {
      throw new Error('not_found')
    })

    openSessionPicker(app)
    // The list loads after the sheet is up (it asks git for the project).
    await vi.waitFor(() => {
      must(app.overlays.at(-1)).onKey(key('enter'))
      expect(gw.methods('session.resume')).toHaveLength(1)
    })
    await flush()
    await flush()
    process.off('unhandledRejection', unhandled)

    expect(unhandled).not.toHaveBeenCalled()
    expect(notices(app).at(-1)).toBe('Could not resume: not_found')
    expect(app.session.ref.live).toBe('s1')
  })

  it("shows a resumed session's prompts still waiting in the gateway's queue", async () => {
    const app = await started(gw)
    gw.handlers.set('session.resume', p => ({
      info: {
        pending_submissions: [
          { admission_id: 'a1', input_id: 'i1', status: 'started', user: 'running now' },
          { admission_id: 'a2', input_id: 'i2', status: 'queued', user: 'after that' }
        ],
        stored_session_id: p['session_id']
      },
      running: true,
      session_id: p['session_id'],
      subscription_id: 'sub-old'
    }))
    given.busy(app.stores, null)

    await app.resume(storedSessionId('old'))

    expect(app.control().queued).toBe(1)
  })

  it('shows an otherwise unhandled error in the chat', async () => {
    const app = await started(gw)
    app.fault(new Error('boom'))

    expect(notices(app).at(-1)).toBe('Unexpected error: boom')
  })



  it('/new detaches the old session only after the new one exists', async () => {
    const app = await started(gw)
    gw.handlers.set('session.create', () => {
      throw new Error('gateway not running')
    })

    await expect(app.newSession()).rejects.toThrow('gateway not running')
    expect(app.session.ref.live).toBe('s1')
    expect(gw.methods('session.detach')).toHaveLength(0)

    gw.handlers.set('session.create', () => ({ session_id: 's2', subscription_id: 'sub2' }))
    await app.newSession()

    expect(app.session.ref.live).toBe('s2')
    expect(gw.methods('session.detach').map(c => c.params)).toEqual([
      { end_reason: 'tui_close', session_id: 's1', subscription_id: 'sub1' }
    ])
  })

  it('a superseded resume of the session the view adopts keeps its shared subscription', async () => {
    for (const staleFirst of [true, false]) {
      gw = new FakeGateway()
      gw.handlers.set('setup.status', () => ({ provider_configured: true }))
      gw.handlers.set('session.create', () => ({ session_id: 's1', subscription_id: 'sub1' }))
      const app = await started(gw)
      const answers: (() => void)[] = []
      // The gateway hands one actor the same subscription for every attach of a session.
      gw.handlers.set('session.resume', p => new Promise(resolve => answers.push(() => resolve({ session_id: p['session_id'], subscription_id: 'sub-x' }))))

      const stale = app.resume(storedSessionId('x'))
      const winner = app.resume(storedSessionId('x'))
      await flush()
      const [first, second] = answers

      if (staleFirst) {
        must(first)()
        await flush()
        must(second)()
      } else {
        must(second)()
        await flush()
        must(first)()
      }

      await Promise.all([stale, winner])
      await flush()

      expect(app.session.ref.live).toBe('x')
      expect(gw.methods('session.detach').map(c => c.params)).toEqual([
        { end_reason: 'tui_close', session_id: 's1', subscription_id: 'sub1' }
      ])
    }
  })

  it('a superseded resume of another session detaches it after the switch lands, with no end reason', async () => {
    const app = await started(gw)
    const answers = new Map<string, () => void>()
    gw.handlers.set('session.resume', p => new Promise(resolve => {
      answers.set(String(p['session_id']), () => resolve({ session_id: p['session_id'], subscription_id: `sub-${p['session_id']}` }))
    }))

    const skipped = app.resume(storedSessionId('a'))
    const chosen = app.resume(storedSessionId('b'))
    await flush()
    must(answers.get('a'))()
    await skipped
    expect(gw.methods('session.detach')).toHaveLength(0)

    must(answers.get('b'))()
    await chosen
    await flush()

    expect(app.session.ref.live).toBe('b')
    expect(gw.methods('session.detach').map(c => c.params)).toEqual([
      { session_id: 'a', subscription_id: 'sub-a' },
      { end_reason: 'tui_close', session_id: 's1', subscription_id: 'sub1' }
    ])
  })

  it('a resume of a session waits for its detach in flight', async () => {
    const app = await started(gw)
    let detached!: () => void
    gw.handlers.set('session.detach', () => new Promise<void>(resolve => (detached = resolve)))

    await app.resume(storedSessionId('b'))
    const back = app.resume(storedSessionId('s1'))
    await flush()
    expect(gw.methods('session.resume').map(c => c.params['session_id'])).toEqual(['b'])

    detached()
    await back

    expect(gw.methods('session.resume').map(c => c.params['session_id'])).toEqual(['b', 's1'])
    expect(app.session.ref.live).toBe('s1')
  })

  it('/new waits while a turn runs, so its queue never lands in the new session', async () => {
    const app = await started(gw)
    given.busy(app.stores, { label: 'Working…', since: {}, startedAt: Date.now() })
    app.stores.queue.hold({ images: [], kind: 'app', text: 'for the old chat' })

    await app.newSession()

    expect(app.session.ref.live).toBe('s1')
    expect(gw.methods('session.create')).toHaveLength(1)
    expect(app.stores.queue.held).toEqual([{ images: [], kind: 'app', text: 'for the old chat' }])
    expect(notices(app).at(-1)).toMatch(/Wait for the current turn/)
  })

  it("/new <title> names the new session, and the old session's prompts close", async () => {
    const app = await started(gw)
    // The tab title goes out as an OSC on stdout.
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    gw.handlers.set('session.mutate', p => ({ title: record(p['payload'])?.['title'] }))
    app.open(stubOverlay('prompt:old'))

    await app.newSession('Release notes')
    await flush()

    expect(app.session.ref.live).toBe('s2')
    expect(app.overlays.some(o => o.key.startsWith('prompt:'))).toBe(false)
    expect(must(gw.methods('session.mutate')[0]).params).toMatchObject({ operation: 'rename', payload: { title: 'Release notes' }, session_id: 's2' })
    expect(app.stores.title.text).toBe('Release notes')
  })

  it('says the connection dropped once per outage, not once per redial', async () => {
    const app = await started(gw)

    gw.emit('exit', null)
    gw.emit('exit', null)
    gw.emit('exit', null)
    expect(notices(app)).toEqual(['Lost the connection to Hermes; reconnecting…'])

    // The reconnect reloads the session (and its transcript); the next outage says so again.
    gw.event({ payload: {}, type: 'gateway.ready' })
    await flush()
    await flush()
    expect(notices(app)).toEqual(['Reconnected to the agent backend.'])
    gw.emit('exit', 1)
    gw.emit('exit', 1)

    expect(notices(app)).toEqual(['Reconnected to the agent backend.', 'Lost the connection to Hermes; reconnecting…'])
  })

  it('says the backend exited when it ran as a child process', async () => {
    gw.attached = false
    const app = await started(gw)

    gw.emit('exit', 1)
    gw.emit('exit', 1)

    expect(notices(app)).toEqual(['The agent backend exited (1).'])
  })
})
