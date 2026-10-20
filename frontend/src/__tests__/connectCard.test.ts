// The connect card in the app: the poll that follows the watcher's file, the message that tells the
// agent, Continue, and a resume that draws each card as it ended.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { toolCallId } from '../core/ids.js'

import { FakeGateway, fakeTern } from './fakes.js'

const home = mkdtempSync(join(tmpdir(), 'hermes-tern-connect-'))
process.env.HERMES_HOME = home

vi.mock('../hermes/sessionIndex.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../hermes/sessionIndex.js')>()),
  lastReply: () => '',
  storedSessions: () => []
}))

const { App } = await import('../app.js')
const { POLL_MS } = await import('../connections.js')
const { toolNode } = await import('../view/tools.js')

const cards = join(home, 'plugin-data', 'hermes-tern', 'connections')

const flush = () => new Promise(resolve => setImmediate(resolve))

function writeCard(stem: string, data: Record<string, unknown>) {
  mkdirSync(cards, { recursive: true })
  writeFileSync(join(cards, `${stem}.json`), JSON.stringify({ pid: process.pid, updated_at: Date.now() / 1000, ...data }))
}

const drive = (state: string, over: Record<string, unknown> = {}) => ({
  settled_by: null,
  targets: [{ connect_url: 'https://portal/x', name: 'googledrive', state }],
  watching: true,
  ...over
})

const complete = (id: string, op: string) => ({
  payload: {
    name: 'manage_connections',
    result: JSON.stringify({ op_id: op, status: 'initiated', targets: [{ name: 'googledrive', state: 'initiated' }] }),
    tool_id: id
  },
  session_id: 's1',
  type: 'tool.complete'
})

/** What the app sent the agent: prompts it submitted, and those queued behind a turn. */
const told = (gw: FakeGateway, app: InstanceType<typeof App>) => [
  ...gw.methods('prompt.submit').map(c => String(c.params.text)),
  ...app.queue.map(q => q.text)
]

let gw: FakeGateway
let tern: ReturnType<typeof fakeTern>

async function started() {
  tern = fakeTern()
  const app = new App(tern.session, gw.client, '')
  void app.run()
  gw.event({ type: 'gateway.ready', payload: {} })
  await flush()
  await flush()

  return app
}

beforeEach(() => {
  gw = new FakeGateway()
  gw.handlers.set('setup.status', () => ({ provider_configured: true }))
  gw.handlers.set('session.create', () => ({ info: { stored_session_id: 's1' }, session_id: 's1', subscription_id: 'sub1' }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the connect card', () => {
  it('follows the watcher and tells the agent once every app is connected', async () => {
    const app = await started()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    writeCard('call_a.op1', drive('initiated'))

    gw.event(complete('call_a', 'op1'))
    const call = app.transcript.call(toolCallId('call_a'))!
    expect(call.connect).toMatchObject({ key: 'call_a.op1', settled: undefined, told: false })

    writeCard('call_a.op1', drive('connected', { settled_by: 'all_resolved', watching: false }))
    vi.advanceTimersByTime(POLL_MS)
    await flush()

    expect(call.connect).toMatchObject({ settled: 'all_resolved', told: true })
    expect(told(gw, app)).toEqual(['Google Drive is connected now. Carry on.'])

    // A settled card is not read again, and nobody is told twice.
    vi.advanceTimersByTime(POLL_MS * 3)
    expect(told(gw, app)).toHaveLength(1)
  })

  it('a reused call id draws its own operation\'s card, not the earlier one', async () => {
    const app = await started()
    writeCard('call_0.op1', drive('connected', { settled_by: 'all_resolved', watching: false }))
    writeCard('call_0.op2', drive('initiated'))

    gw.event(complete('call_0', 'op2'))

    expect(app.transcript.call(toolCallId('call_0'))?.connect).toMatchObject({ key: 'call_0.op2', settled: undefined })
  })

  it('Continue tells the agent once and the card stays told after a resume', async () => {
    const app = await started()
    writeCard('call_b.op3', drive('initiated'))
    gw.event(complete('call_b', 'op3'))
    const ref = app.transcript.call(toolCallId('call_b'))!.connect!.key!

    tern.send({ act: 'connect-continue', ev: 'action', value: ref })
    await flush()
    tern.send({ act: 'connect-continue', ev: 'action', value: ref })
    await flush()

    expect(told(gw, app)).toEqual(["I've authorized Google Drive. Check with manage_connections status and carry on."])
    // As on the desktop, Continue settles the card: no Authorize, no Continue, the wait is over.
    expect(app.transcript.call(toolCallId('call_b'))!.connect).toMatchObject({ settled: 'continued', told: true })

    // The resume brings the call back without its result: the card is found by its call id.
    gw.handlers.set('session.resume', p => ({
      info: { stored_session_id: p.session_id },
      messages: [
        { role: 'user', text: 'connect drive', timestamp: Date.now() / 1000 },
        { args: { action: 'connect', connectors: ['googledrive'] }, name: 'manage_connections', role: 'tool', timestamp: Date.now() / 1000, tool_call_id: 'call_b' }
      ],
      session_id: p.session_id,
      subscription_id: 'sub-again'
    }))
    gw.event({ payload: {}, type: 'gateway.ready' })
    await flush()
    await flush()

    const again = app.transcript.call(toolCallId('call_b'))!
    expect(again).not.toBe(undefined)
    expect(again.connect).toMatchObject({ key: 'call_b.op3', told: true })
  })

  it('a resume draws each card as it ended, never a stale wait', async () => {
    const app = await started()
    const now = Date.now() / 1000
    writeCard('call_c.op4', drive('initiated', { created_at: now, pid: 2 ** 22 + 4321 }))
    writeCard('call_d.op5', drive('superseded', { created_at: now, settled_by: 'superseded', watching: false }))
    gw.handlers.set('session.resume', p => ({
      info: { stored_session_id: p.session_id },
      messages: [
        { role: 'user', text: 'connect drive', timestamp: now },
        { args: { action: 'connect' }, name: 'manage_connections', role: 'tool', timestamp: now, tool_call_id: 'call_d' },
        { args: { action: 'connect' }, name: 'manage_connections', role: 'tool', timestamp: now, tool_call_id: 'call_c' }
      ],
      session_id: p.session_id,
      subscription_id: 'sub-again'
    }))

    gw.event({ payload: {}, type: 'gateway.ready' })
    await flush()
    await flush()

    // Its gateway is gone: the card is a summary, its app not connected, with no controls.
    const stopped = app.transcript.call(toolCallId('call_c'))!
    expect(stopped.connect).toMatchObject({ settled: 'stopped' })
    const view = JSON.stringify(toolNode(stopped, Date.now()))
    expect(view).toContain('not connected')
    expect(view).not.toContain('connect-open')
    expect(view).not.toContain('connect-continue')
    // A card a later request replaced is the plain tool call.
    expect(JSON.stringify(toolNode(app.transcript.call(toolCallId('call_d'))!, Date.now()))).not.toContain('hermes.connect.row')
    expect(told(gw, app)).toEqual([])
  })
})
