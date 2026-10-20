// Which of the session's two ids each use takes: the runtime id (what the gateway's requests name)
// or the stored id (what the session is filed and resumed under, with the runtime id standing in
// while no stored id is known). These pin the values the pane used before its ids were branded.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { durable, isLive, liveSessionId, NO_SESSION, prKey, stackKey, storedSessionId } from '../core/ids.js'
import { snapshotIds } from '../wire/rpc.js'

import { FakeGateway, fakeTern, settle } from './fakes.js'

process.env['HERMES_HOME'] = mkdtempSync(join(tmpdir(), 'hermes-tern-ids-'))

const spy = vi.hoisted(() => ({
  active: vi.fn(),
  compactions: vi.fn((_sid: string) => []),
  links: vi.fn((_sid: string) => []),
  markViewer: vi.fn()
}))

vi.mock('../connections.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../connections.js')>()),
  markViewer: spy.markViewer
}))
vi.mock('../hermes/activeSessionFile.js', () => ({ writeActiveSessionFile: spy.active }))
vi.mock('../compaction.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../compaction.js')>()),
  storedCompactions: spy.compactions
}))
vi.mock('../github/links.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../github/links.js')>()),
  storedLinks: spy.links
}))
vi.mock('../hermes/sessionIndex.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../hermes/sessionIndex.js')>()),
  lastReply: () => '',
  storedSessions: () => []
}))

const { App } = await import('../app.js')

/** A session the gateway creates: runtime id `live-N`, and stored id `stored-N` unless `stored` is false. */
function gateway({ stored = true } = {}) {
  const gw = new FakeGateway()
  let created = 0
  gw.handlers.set('setup.status', () => ({ provider_configured: true }))
  gw.handlers.set('session.create', () => {
    created++

    return { info: stored ? { stored_session_id: `stored-${created}` } : {}, session_id: `live-${created}`, subscription_id: `sub-${created}` }
  })
  gw.handlers.set('session.resume', p => ({
    info: stored ? { stored_session_id: p['session_id'] } : {},
    running: false,
    session_id: `live-of-${String(p['session_id'])}`,
    subscription_id: `sub-of-${String(p['session_id'])}`
  }))

  return gw
}

async function started(gw: FakeGateway) {
  const app = new App(fakeTern().session, gw.client, '')
  const done = app.run()
  gw.event({ payload: {}, type: 'gateway.ready' })
  await settle(gw)

  return { app, done }
}

const resumed = (gw: FakeGateway) => gw.sent('session.resume').map(p => p['session_id'])

beforeEach(() => {
  for (const fn of Object.values(spy)) {
    fn.mockClear()
  }
})

describe('a session with a stored id', () => {
  it('reads its runtime id for requests and its stored id for filing', async () => {
    const gw = gateway()
    const { app } = await started(gw)

    expect(app.sid).toBe('live-1')
    expect(app.storedSid).toBe('stored-1')
    expect(app.session.ref).toEqual({ live: 'live-1', stored: 'stored-1' })
    expect(spy.markViewer.mock.calls).toEqual([['stored-1', null]])
    expect(spy.active.mock.calls).toEqual([['stored-1']])
    expect(spy.links.mock.calls).toEqual([['stored-1']])
  })

  it('files a resumed session and its stored compactions under the stored id', async () => {
    const gw = gateway()
    const { app } = await started(gw)
    gw.handlers.set('session.resume', p => ({
      info: { stored_session_id: p['session_id'] },
      messages: [{ role: 'user', text: 'hello' }],
      session_id: 'live-2',
      subscription_id: 'sub-2'
    }))

    await app.resume(storedSessionId('stored-2'))
    await settle(gw)

    expect(app.sid).toBe('live-2')
    expect(spy.markViewer.mock.calls.at(-1)).toEqual(['stored-2', 'stored-1'])
    expect(spy.active.mock.calls.at(-1)).toEqual(['stored-2'])
    expect(spy.compactions.mock.calls).toEqual([['stored-2']])
    expect(spy.links.mock.calls.at(-1)).toEqual(['stored-2'])
  })

  it('unmarks the stored id on quit', async () => {
    const gw = gateway()
    const { app, done } = await started(gw)

    app.quit()
    await done

    expect(spy.markViewer.mock.calls.at(-1)).toEqual([null, 'stored-1'])
  })

  it('keeps the stored id while the gateway is down, and reattaches under it', async () => {
    const gw = gateway()
    const { app } = await started(gw)

    gw.emit('exit', 1)
    expect(app.sid).toBeNull()
    expect(app.storedSid).toBe('stored-1')
    expect(app.session.ref).toEqual({ live: null, stored: 'stored-1' })

    gw.event({ payload: {}, type: 'gateway.ready' })
    await settle(gw)

    expect(resumed(gw)).toEqual(['stored-1'])
    expect(gw.sent('session.create')).toHaveLength(1)
    expect(app.sid).toBe('live-of-stored-1')
  })

  it('reloads a session that fell behind under its stored id', async () => {
    const gw = gateway()
    await started(gw)

    gw.event({ payload: { latest_seq: 3 }, session_id: 'live-1', type: 'session.replay_gap' })
    await settle(gw)

    expect(resumed(gw)).toEqual(['stored-1'])
  })

  it('reads the summaries of its compactions under the stored id', async () => {
    const gw = gateway()
    await started(gw)

    gw.event({ payload: {}, session_id: 'live-1', type: 'message.start' })
    gw.event({ payload: { kind: 'compacting', text: 'Compacting context' }, session_id: 'live-1', type: 'status.update' })
    gw.event({ payload: { kind: 'compacted', text: 'Compacted ~182,000 → ~31,000 tokens' }, session_id: 'live-1', type: 'status.update' })
    gw.event({ payload: { text: 'Done.' }, session_id: 'live-1', type: 'message.complete' })
    await vi.waitFor(() => expect(spy.compactions).toHaveBeenCalled())

    expect(spy.compactions.mock.calls[0]).toEqual(['stored-1'])
  })

  it('opens a branch when the session it resumed is the one it asked for', async () => {
    const gw = gateway()
    const { app } = await started(gw)
    // The shared gateway answers a resume with one id for both: its runtime id is the stored one.
    gw.handlers.set('session.resume', p => ({ info: { stored_session_id: p['session_id'] }, session_id: p['session_id'], subscription_id: 'sub-b' }))

    await expect(app.control().open(storedSessionId('branch-1'))).resolves.toBe(true)
    expect(app.sid).toBe('branch-1')

    gw.handlers.set('session.resume', () => ({ info: { stored_session_id: 'elsewhere' }, session_id: 'elsewhere', subscription_id: 'sub-e' }))
    await expect(app.control().open(storedSessionId('branch-2'))).resolves.toBe(false)
  })
})

describe('a session with no stored id', () => {
  it('files it under its runtime id', async () => {
    const gw = gateway({ stored: false })
    const { app, done } = await started(gw)

    expect(app.storedSid).toBeNull()
    expect(app.session.ref).toEqual({ live: 'live-1', stored: null })
    expect(spy.markViewer.mock.calls).toEqual([['live-1', null]])
    expect(spy.active.mock.calls).toEqual([['live-1']])
    expect(spy.links.mock.calls).toEqual([['live-1']])

    app.quit()
    await done

    expect(spy.markViewer.mock.calls.at(-1)).toEqual([null, 'live-1'])
  })

  it('reloads a session that fell behind under its runtime id', async () => {
    const gw = gateway({ stored: false })
    await started(gw)

    gw.event({ payload: { latest_seq: 3 }, session_id: 'live-1', type: 'session.replay_gap' })
    await settle(gw)

    expect(resumed(gw)).toEqual(['live-1'])
  })

  it('starts a new session when the gateway comes back, having nothing to resume', async () => {
    const gw = gateway({ stored: false })
    const { app } = await started(gw)

    gw.emit('exit', 1)
    gw.event({ payload: {}, type: 'gateway.ready' })
    await settle(gw)

    expect(resumed(gw)).toEqual([])
    expect(gw.sent('session.create')).toHaveLength(2)
    expect(app.sid).toBe('live-2')
  })

  it('reads no stored compactions: their summaries need a stored id', async () => {
    const gw = gateway({ stored: false })
    await started(gw)

    gw.event({ payload: {}, session_id: 'live-1', type: 'message.start' })
    gw.event({ payload: { kind: 'compacting', text: 'Compacting context' }, session_id: 'live-1', type: 'status.update' })
    gw.event({ payload: { kind: 'compacted', text: 'Compacted ~182,000 → ~31,000 tokens' }, session_id: 'live-1', type: 'status.update' })
    gw.event({ payload: { text: 'Done.' }, session_id: 'live-1', type: 'message.complete' })
    await settle(gw)
    await new Promise(resolve => setTimeout(resolve, 5))

    expect(spy.compactions).not.toHaveBeenCalled()
  })
})

describe('the id helpers', () => {
  it('reads the stored id of a snapshot from its info, else from the result, and an empty one as none', () => {
    expect(snapshotIds({ info: { stored_session_id: 'a' }, session_id: 'l', stored_session_id: 'b', subscription_id: 'sub' })).toEqual({
      ref: { live: 'l', stored: 'a' },
      subscription: 'sub'
    })
    expect(snapshotIds({ info: { stored_session_id: '' }, session_id: 'l', stored_session_id: 'b' }).ref).toEqual({ live: 'l', stored: 'b' })
    expect(snapshotIds({ session_id: 'l', stored_session_id: '', subscription_id: '' })).toEqual({ ref: { live: 'l', stored: null }, subscription: undefined })
  })

  it('files a session under its stored id, else its runtime id', () => {
    const live = liveSessionId('l')

    expect(durable({ live, stored: storedSessionId('s') })).toBe('s')
    expect(durable({ live, stored: null })).toBe('l')
    expect(durable({ live: null, stored: storedSessionId('s') })).toBe('s')
    expect(durable(NO_SESSION)).toBeNull()
    expect(isLive({ live, stored: null })).toBe(true)
    expect(isLive({ live: null, stored: storedSessionId('s') })).toBe(false)
  })

  it('keys a pull request and a stack as before', () => {
    expect(prKey({ host: 'github.com', number: 5, repository: 'acme/app' })).toBe('github.com/acme/app#5')
    expect(stackKey('github.com', 'acme/app', 3)).toBe('github.com/acme/app#stack:3')
  })
})
