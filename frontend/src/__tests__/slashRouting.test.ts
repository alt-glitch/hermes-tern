import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { storedSessionId } from '../core/ids.js'

import { FakeGateway, fakeTern, stubOverlay } from './fakes.js'

process.env.HERMES_HOME = mkdtempSync(join(tmpdir(), 'hermes-tern-slash-'))

vi.mock('../hermes/sessionIndex.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../hermes/sessionIndex.js')>()),
  lastReply: () => '',
  storedSessions: () => []
}))

const { App } = await import('../app/chat.js')

const flush = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

let gw: FakeGateway
let created = 0

async function started() {
  const tern = fakeTern()
  const app = new App(tern.session, gw.client, '')
  void app.run()
  gw.event({ type: 'gateway.ready', payload: {} })
  await flush()

  /** Types `text` into the composer and presses Enter. */
  const submit = async (text: string) => {
    app.composer.set(text)
    tern.press('enter')
    await flush()
  }

  return { app, submit }
}

const notices = (app: InstanceType<typeof App>) =>
  app.transcript.entries.flatMap(e => (e.kind === 'notice' ? [e.text] : []))

const prompt = (key: string) => stubOverlay(key, { modal: true })

beforeEach(() => {
  created = 0
  gw = new FakeGateway()
  gw.handlers.set('setup.status', () => ({ provider_configured: true }))
  gw.handlers.set('session.create', () => {
    created++

    return { info: { stored_session_id: `s${created}` }, session_id: `s${created}`, subscription_id: `sub${created}` }
  })
  gw.handlers.set('session.resume', p => ({
    info: { stored_session_id: p.session_id },
    running: false,
    session_id: p.session_id,
    subscription_id: `sub-${p.session_id}`
  }))
  gw.handlers.set('commands.catalog', () => ({
    canon: { '/heartbeat': '/heartbeat', '/save': '/save', '/sessions': '/sessions', '/status': '/status', '/statusbar': '/statusbar', '/bundles': '/bundles', '/busy': '/busy', '/mouse': '/mouse' },
    skills: { '/stat-skill': {} }
  }))
})

describe('slash name resolution', () => {
  it('runs the one command a typed prefix names (Ink: /hea is /heartbeat)', async () => {
    const { submit } = await started()

    await submit('/hea every 5m')

    expect(gw.methods('slash.exec').map(c => c.params.command)).toEqual(['heartbeat every 5m'])
  })

  it('says which commands an ambiguous prefix could mean, and runs none', async () => {
    const { app, submit } = await started()

    await submit('/bu')

    expect(gw.methods('slash.exec')).toHaveLength(0)
    expect(notices(app).at(-1)).toBe('/bu could mean /bundles, /busy. Type more of the name.')
  })

  it("matches this frontend's own commands in any case", async () => {
    const { app, submit } = await started()

    await submit('/Clear')

    expect(gw.methods('session.create')).toHaveLength(2)
    expect(app.session.ref.live).toBe('s2')
  })

  it('loads the catalog once per session, and again after /reload-skills', async () => {
    const { submit } = await started()

    await submit('/status')
    await submit('/heartbeat')
    expect(gw.methods('commands.catalog')).toHaveLength(1)

    await submit('/reload-skills')
    await submit('/status')
    expect(gw.methods('commands.catalog')).toHaveLength(2)
  })
})

describe('a slash reply after a session switch', () => {
  it('is dropped, so its prompt never reaches the session switched to', async () => {
    const { app, submit } = await started()
    const reply = Promise.withResolvers<unknown>()
    gw.handlers.set('slash.exec', () => reply.promise)

    await submit('/heartbeat check the build')
    expect(gw.methods('slash.exec')).toHaveLength(1)

    await app.resume(storedSessionId('other'))
    expect(app.session.ref.live).toBe('other')
    reply.resolve({ message: 'check the build', type: 'send' })
    await flush()

    expect(gw.methods('prompt.submit')).toHaveLength(0)
    expect(app.transcript.entries.some(e => e.kind === 'user')).toBe(false)
  })

  it('still lands while the view stays on its session', async () => {
    const { submit } = await started()
    gw.handlers.set('slash.exec', () => ({ message: 'check the build', type: 'send' }))

    await submit('/heartbeat check the build')

    expect(gw.methods('prompt.submit').map(c => c.params.session_id)).toEqual(['s1'])
  })
})

describe('stale prompt sheets', () => {
  it('a reattach closes the shared sheets it re-hydrates, and keeps a legacy request', async () => {
    const { app } = await started()
    app.open(prompt('prompt:shared:p1'))
    app.open(prompt('prompt:r1'))

    gw.event({ payload: { latest_seq: 9 }, session_id: 's1', type: 'session.replay_gap' })
    await flush()

    expect(app.overlays.map(o => o.key)).toEqual(['prompt:r1'])
  })

  it('approval.cancelled closes the approvals it names, and not a sheet that took a closed one\'s key', async () => {
    const { app } = await started()
    const sid = app.session.ref.live ?? ''
    const ask = (id: string, method: string, params: Record<string, unknown>) =>
      gw.emit('request', { fail: () => undefined, id, method, params: { session_id: sid, ...params }, respond: () => undefined })

    ask('r1', 'approval', { command: 'ls', request_id: 'q1' })
    ask('r2', 'approval', { command: 'make', request_id: 'q2' })
    const answered = app.overlays.find(o => o.key === 'prompt:r1')
    expect(answered).toBeDefined()

    if (answered) {
      app.close(answered)
    }

    ask('r1', 'sudo', {})

    gw.event({ payload: { request_ids: ['q1', 'q2'] }, session_id: sid, type: 'approval.cancelled' })

    expect(app.overlays.map(o => o.key)).toEqual(['prompt:r1'])
  })

  it('the backend exiting closes every prompt sheet', async () => {
    const { app } = await started()
    app.open(prompt('prompt:shared:p1'))
    app.open(prompt('prompt:r1'))
    app.open(stubOverlay('help'))

    gw.emit('exit', 1)

    expect(app.overlays.map(o => o.key)).toEqual(['help'])
  })
})
