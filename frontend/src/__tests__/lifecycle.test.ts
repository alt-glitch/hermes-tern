import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.HERMES_HOME = mkdtempSync(join(tmpdir(), 'hermes-tern-lifecycle-'))

// The picker reads state.db; here it lists one other session.
vi.mock('../hermes/sessionIndex.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../hermes/sessionIndex.js')>()),
  lastReply: () => '',
  storedSessions: () => [
    {
      branch: '', cwd: '', id: 'gone', lastActive: Date.now(), messages: 2, model: '', pinned: false,
      preview: 'an old chat', repoRoot: '', source: 'tui', startedAt: Date.now(), title: 'Old chat'
    }
  ]
}))

const { App } = await import('../app.js')
const { openSessionPicker } = await import('../overlays/sessions.js')

type Handler = (params: Record<string, unknown>) => unknown

/** A shared-gateway stand-in: `request` answers from `handlers` (else `{}`), `event` feeds the app. */
class FakeGateway extends EventEmitter {
  isCanonical = true
  attached = true
  readonly calls: { method: string; params: Record<string, unknown> }[] = []
  readonly handlers = new Map<string, Handler>()

  request(method: string, params: Record<string, unknown> = {}) {
    this.calls.push({ method, params })
    const handler = this.handlers.get(method)

    try {
      return Promise.resolve(handler ? handler(params) : {})
    } catch (error) {
      return Promise.reject(error)
    }
  }

  methods(name: string) {
    return this.calls.filter(c => c.method === name)
  }

  event(ev: Record<string, unknown>) {
    this.emit('event', ev)
  }

  drain() {}
  kill() {}
  holdAttach() {
    return undefined
  }
  settleAttach() {}
  hydrateSharedPrompts() {}
}

/** A Tern session whose surface draws nothing and whose input never arrives. */
function fakeTern() {
  const surface: object = new Proxy({}, { get: (_, key) => (key === 'closed' ? true : () => surface) })

  return {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
    blob: () => 'blob',
    caps: { cols: 80, features: [] },
    close: async () => undefined,
    open: () => surface
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

async function started(gw: FakeGateway) {
  const app = new App(fakeTern() as never, gw as never, '')
  void app.run()
  gw.event({ type: 'gateway.ready', payload: {} })
  await flush()
  await flush()

  return app
}

const notices = (app: InstanceType<typeof App>) =>
  app.transcript.entries.flatMap(e => (e.kind === 'notice' ? [(e as unknown as { text: string }).text] : []))

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
    info: { stored_session_id: p.session_id },
    revision: 1,
    running: false,
    session_id: p.session_id,
    subscription_id: `sub-${p.session_id}`
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('session lifecycle', () => {
  it('starts a session on the first gateway.ready', async () => {
    const app = await started(gw)

    expect(app.sid).toBe('s1')
  })

  it('reloads the shown session on a replay gap, with a fresh subscription and its turn state', async () => {
    const app = await started(gw)
    app.busy = { label: 'Working…', since: {}, startedAt: Date.now() }
    gw.handlers.set('session.resume', p => ({ running: false, session_id: p.session_id, subscription_id: 'sub-fresh' }))

    gw.event({ payload: { latest_seq: 9 }, session_id: 'other', type: 'session.replay_gap' })
    await flush()
    expect(gw.methods('session.resume')).toHaveLength(0)

    gw.event({ payload: { latest_seq: 9 }, session_id: 's1', type: 'session.replay_gap' })
    await flush()
    await flush()

    expect(gw.methods('session.resume').map(c => c.params.session_id)).toEqual(['s1'])
    expect(app.busy).toBeNull()
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
      app.overlays.at(-1)!.onKey({ name: 'enter' } as never)
      expect(gw.methods('session.resume')).toHaveLength(1)
    })
    await flush()
    await flush()
    process.off('unhandledRejection', unhandled)

    expect(unhandled).not.toHaveBeenCalled()
    expect(notices(app).at(-1)).toBe('Could not resume: not_found')
    expect(app.sid).toBe('s1')
  })

  it('shows an otherwise unhandled error in the chat', async () => {
    const app = await started(gw)
    app.fault(new Error('boom'))

    expect(notices(app).at(-1)).toBe('Unexpected error: boom')
  })

  it('/branch branches through session.mutate and moves the view to the child', async () => {
    const app = await started(gw)
    gw.handlers.set('session.mutate', () => ({ branched_session_id: 'child', operation: 'branch' }))
    gw.handlers.set('session.info', () => ({ title: 'Lane #2' }))

    await app.branch('')
    await flush()

    const mutate = gw.methods('session.mutate')[0]!.params
    expect(mutate).toMatchObject({ expected_generation: 1, expected_revision: 1, operation: 'branch', payload: {}, session_id: 's1' })
    expect(app.sid).toBe('child')
    expect(gw.methods('session.detach').map(c => c.params.session_id)).toEqual(['s1'])
    expect(notices(app).at(-1)).toBe('Branched to Lane #2.')
    expect(gw.methods('slash.exec')).toHaveLength(0)
  })

  it('/branch <title> names the child and waits while a turn runs', async () => {
    const app = await started(gw)
    gw.handlers.set('session.mutate', () => ({ branched_session_id: 'child' }))
    app.busy = { label: 'Working…', since: {}, startedAt: Date.now() }

    await app.branch('side quest')
    expect(gw.methods('session.mutate')).toHaveLength(0)
    expect(notices(app).at(-1)).toMatch(/Wait for the current turn/)

    app.busy = null
    await app.branch('side quest')
    expect(gw.methods('session.mutate')[0]!.params.payload).toEqual({ title: 'side quest' })
  })

  it('/new detaches the old session only after the new one exists', async () => {
    const app = await started(gw)
    gw.handlers.set('session.create', () => {
      throw new Error('gateway not running')
    })

    await expect(app.newSession()).rejects.toThrow('gateway not running')
    expect(app.sid).toBe('s1')
    expect(gw.methods('session.detach')).toHaveLength(0)

    gw.handlers.set('session.create', () => ({ session_id: 's2', subscription_id: 'sub2' }))
    await app.newSession()

    expect(app.sid).toBe('s2')
    expect(gw.methods('session.detach').map(c => c.params)).toEqual([
      { end_reason: 'tui_close', session_id: 's1', subscription_id: 'sub1' }
    ])
  })

  it('/new waits while a turn runs, so its queue never lands in the new session', async () => {
    const app = await started(gw)
    app.busy = { label: 'Working…', since: {}, startedAt: Date.now() }
    app.queue.push('for the old chat')

    await app.newSession()

    expect(app.sid).toBe('s1')
    expect(gw.methods('session.create')).toHaveLength(1)
    expect(app.queue).toEqual(['for the old chat'])
    expect(notices(app).at(-1)).toMatch(/Wait for the current turn/)
  })

  it("/new <title> names the new session, and the old session's prompts close", async () => {
    const app = await started(gw)
    // The tab title goes out as an OSC on stdout.
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    gw.handlers.set('session.mutate', p => ({ title: (p.payload as { title: string }).title }))
    app.open({ key: 'prompt:old', node: () => null as never, onKey: () => true })

    await app.newSession('Release notes')
    await flush()

    expect(app.sid).toBe('s2')
    expect(app.overlays.some(o => o.key.startsWith('prompt:'))).toBe(false)
    expect(gw.methods('session.mutate')[0]!.params).toMatchObject({ operation: 'rename', payload: { title: 'Release notes' }, session_id: 's2' })
    expect(app.title).toBe('Release notes')
    expect(notices(app).at(-1)).toBe('Session title set: Release notes')
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
