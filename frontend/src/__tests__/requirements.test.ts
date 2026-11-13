// The pane checks what the gateway supports before it opens a session (hermes/requirements.ts).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readLaunchEnv } from '../config/env.js'
import { REQUIRED_CAPABILITIES } from '../hermes/requirements.js'

import { FakeGateway, fakeTern } from './fakes.js'

process.env['HERMES_HOME'] = mkdtempSync(join(tmpdir(), 'hermes-tern-requirements-'))
// The tab's title is not this test's; it would print to the runner's terminal.
vi.mock('../surface/osc.js', () => ({ reportCwd: () => undefined, setTabTitle: () => undefined }))

const { App } = await import('../app/chat.js')

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const notices = (app: InstanceType<typeof App>) => app.transcript.entries.flatMap(e => (e.kind === 'notice' ? [e.text] : []))

let gw: FakeGateway

beforeEach(() => {
  gw = new FakeGateway()
  gw.handlers.set('setup.status', () => ({ provider_configured: true }))
  gw.handlers.set('session.create', () => ({ info: { stored_session_id: 'new' }, session_id: 'new', subscription_id: 'sub-new' }))
})

async function ready() {
  gw.event({ type: 'gateway.ready', payload: {} })
  await flush()
  await flush()
}

async function started() {
  const app = new App(fakeTern().session, gw.client, '', { launch: readLaunchEnv({}, '/work') })
  void app.run()
  await ready()

  return app
}

describe('what the gateway must support', () => {
  it('opens a session on a gateway that lists every capability', async () => {
    const app = await started()

    expect(gw.sent('runtime.describe')).toEqual([{}])
    expect(gw.methods('session.create')).toHaveLength(1)
    expect(notices(app)).toEqual([])
  })

  it('opens no session on an older gateway, and says what to run', async () => {
    const older = REQUIRED_CAPABILITIES.filter(name => name !== 'session-transcript-v1')
    gw.handlers.set('runtime.describe', () => ({ capabilities: older }))
    const app = await started()

    expect(gw.methods('session.create')).toHaveLength(0)
    expect(notices(app)).toEqual([
      'This Hermes is older than hermes tern needs (it lacks session-transcript-v1). Run `hermes update`, then start `hermes tern` again.'
    ])
  })

  it('opens no session on a gateway whose session list has no cursor', async () => {
    gw.handlers.set('runtime.describe', () => ({ capabilities: REQUIRED_CAPABILITIES.filter(name => name !== 'session-list-cursor-v1') }))
    const app = await started()

    expect(gw.methods('session.create')).toHaveLength(0)
    expect(notices(app)).toEqual([
      'This Hermes is older than hermes tern needs (it lacks session-list-cursor-v1). Run `hermes update`, then start `hermes tern` again.'
    ])
  })

  it('asks again on the next gateway.ready when the question failed', async () => {
    gw.handlers.set('runtime.describe', () => {
      throw new Error('socket closed')
    })
    const app = await started()

    expect(gw.methods('session.create')).toHaveLength(0)
    expect(notices(app)).toEqual(['Could not read what the agent backend supports: socket closed'])

    gw.handlers.set('runtime.describe', () => ({ capabilities: REQUIRED_CAPABILITIES }))
    await ready()

    expect(gw.methods('session.create')).toHaveLength(1)
  })
})
