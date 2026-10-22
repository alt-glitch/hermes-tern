import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readLaunchEnv } from '../config/env.js'
import { storedSessionId } from '../core/ids.js'
import { forgetPane, markPane, paneFile } from '../session/pane.js'
import { parseJson, record } from '../wire/json.js'

import { FakeGateway, fakeTern } from './fakes.js'

process.env['HERMES_HOME'] = mkdtempSync(join(tmpdir(), 'hermes-tern-pane-'))
// The tab's title is not this test's; it would print to the runner's terminal.
vi.mock('../surface/osc.js', () => ({ reportCwd: () => undefined, setTabTitle: () => undefined }))

const { App } = await import('../app/chat.js')
const { dataDir } = await import('../connections/cards.js')

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const read = (pane: string, dir = dataDir()) => record(parseJson(readFileSync(paneFile(pane, dir), 'utf8'))) ?? {}
const notices = (app: InstanceType<typeof App>) => app.transcript.entries.flatMap(e => (e.kind === 'notice' ? [e.text] : []))

let gw: FakeGateway
let pane = 0

beforeEach(() => {
  pane++
  gw = new FakeGateway()
  gw.handlers.set('setup.status', () => ({ provider_configured: true }))
  gw.handlers.set('session.create', () => ({ info: { stored_session_id: 'new' }, session_id: 'new', subscription_id: 'sub-new' }))
  gw.handlers.set('session.resume', p => ({ info: { stored_session_id: p['session_id'], title: 'Fix the parser' }, running: false, session_id: p['session_id'], subscription_id: 'sub' }))
})

/** An app in Tern pane `pane`, started with `env` from the launcher. */
async function started(env: Record<string, string> = {}) {
  const tern = fakeTern()
  const app = new App(tern.session, gw.client, '', { launch: readLaunchEnv({ HERMES_TERN_LAUNCH_CWD: '/work', TERN_PANE: String(pane), ...env }, '/elsewhere') })
  const done = app.run()
  gw.event({ type: 'gateway.ready', payload: {} })
  await flush()
  await flush()

  return { app, done, tern }
}

describe('the pane file', () => {
  it('names the session, the launch folder and this process; nothing outside a Tern pane', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-tern-panes-'))
    markPane({ pane: '7', paneCwd: '/work' }, storedSessionId('s1'), dir)

    expect(read('7', dir)).toMatchObject({ cwd: '/work', pid: process.pid, session_id: 's1' })

    markPane({ pane: '', paneCwd: '/work' }, storedSessionId('s2'), dir)
    forgetPane({ pane: '' }, dir)
    expect(read('7', dir)['session_id']).toBe('s1')

    forgetPane({ pane: '7' }, dir)
    expect(existsSync(paneFile('7', dir))).toBe(false)
  })

  it("follows the pane's session: the first one, then /new's", async () => {
    const { app } = await started()
    expect(read(String(pane))['session_id']).toBe('new')

    await app.resume(storedSessionId('old'))
    expect(read(String(pane))).toMatchObject({ cwd: '/work', session_id: 'old' })
  })

  it('is removed when the user quits, and kept when the input ends on its own', async () => {
    const quitting = await started()
    quitting.app.quit()
    await quitting.done
    expect(existsSync(paneFile(String(pane)))).toBe(false)

    pane++
    const closing = await started()
    closing.tern.end()
    await closing.done
    expect(read(String(pane))['session_id']).toBe('new')
  })
})

describe('a pane restarted after its program died', () => {
  it('resumes the launcher’s session and says so', async () => {
    const { app } = await started({ HERMES_TERN_RESTORED: 'root', HERMES_TUI_RESUME: 'tip' })

    expect(gw.methods('session.create')).toHaveLength(0)
    expect(app.session.ref.stored).toBe('tip')
    expect(notices(app)).toEqual(['Resumed “Fix the parser” after the pane restarted.'])
  })

  it('starts a new session when that one no longer resumes', async () => {
    gw.handlers.set('session.resume', () => {
      throw new Error('session not found')
    })
    const { app } = await started({ HERMES_TERN_RESTORED: 'root', HERMES_TUI_RESUME: 'tip' })

    expect(app.session.ref.live).toBe('new')
    expect(notices(app)).toEqual(["Could not resume this pane's last session (session not found); started a new one."])
  })

  it('says nothing for a plain --resume', async () => {
    const { app } = await started({ HERMES_TUI_RESUME: 'tip' })

    expect(app.session.ref.stored).toBe('tip')
    expect(notices(app)).toEqual([])
  })
})
