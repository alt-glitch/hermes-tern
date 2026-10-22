// The connect card on the shared gateway's own wire (connections/live.ts): `connection.request`
// draws it on the running tool row, its buttons answer through `connection.respond`,
// `connectors.operation.wake` and `connectors.connect`, `connection.update` frames move its rows in
// seq order, a resume's `pending_connection` brings it back, and the file path still works beside it.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { toolCallId } from '../core/ids.js'
import type { ToolCall } from '../model.js'

import { FakeGateway, fakeTern, must } from './fakes.js'

const home = mkdtempSync(join(tmpdir(), 'hermes-tern-live-connect-'))
process.env['HERMES_HOME'] = home

/** The links the app opened in the browser. */
const browsed = vi.hoisted((): string[] => [])

vi.mock('../overlays/pullRequests.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../overlays/pullRequests.js')>()),
  openUrl: (url: string) => void browsed.push(url)
}))
vi.mock('../hermes/sessionIndex.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../hermes/sessionIndex.js')>()),
  lastReply: () => '',
  storedSessions: () => []
}))

const { App } = await import('../app/chat.js')
const { ownsCard } = await import('../view/workLogModel.js')
const { toolNode } = await import('../view/tools/shell.js')

const flush = () => new Promise(resolve => setImmediate(resolve))

const OWNER = { session_id: 's1', type: 'session' }
const FIGMA = 'https://portal/connect/figma'

/** A target as `Target.snapshot` sends it. */
const figma = (state: string, over: Record<string, unknown> = {}) => ({
  action: 'connect',
  connect_url: FIGMA,
  kind: 'connector',
  name: 'figma',
  resolved: state === 'connected' || state === 'skipped',
  state,
  ...over
})

/** `connection.request` for operation `op` of call `call`. */
const request = (op = 'op1', call = 'call_f', targets: unknown[] = [figma('initiated')]) => ({
  payload: { deadline_at: Date.now() / 1000 + 300, op_id: op, seq: 2, targets, timeout_seconds: 300, tool_call_id: call },
  session_id: 's1',
  type: 'connection.request'
})

/** `connection.update` frame `seq` of operation `op`. */
const update = (seq: number, targets: unknown[], over: Record<string, unknown> = {}, op = 'op1') => ({
  payload: { deadline_at: Date.now() / 1000 + 300, op_id: op, owner: OWNER, seq, settled: false, targets, ...over },
  session_id: 's1',
  type: 'connection.update'
})

const toolStart = (id = 'call_f') => ({
  payload: { args: { action: 'connect', connectors: ['figma'] }, name: 'manage_connections', tool_id: id },
  session_id: 's1',
  type: 'tool.start'
})

let gw: FakeGateway
let tern: ReturnType<typeof fakeTern>

async function started() {
  tern = fakeTern()
  const app = new App(tern.session, gw.client, '')
  void app.run()
  gw.event({ payload: {}, type: 'gateway.ready' })
  await flush()
  await flush()

  return app
}

/** A running turn with the connect call started and its card requested. */
async function waitingOnFigma() {
  const app = await started()
  gw.event({ payload: {}, session_id: 's1', type: 'message.start' })
  gw.event(toolStart())
  gw.event(request())
  await flush()

  return { app, call: must(app.transcript.call(toolCallId('call_f'))) }
}

const view = (call: ToolCall) => JSON.stringify(toolNode(call, Date.now()))

const click = async (act: string, value: string) => {
  tern.send({ act, ev: 'action', value })
  await flush()
  await flush()
}

beforeEach(() => {
  browsed.length = 0
  gw = new FakeGateway()
  gw.handlers.set('setup.status', () => ({ provider_configured: true }))
  gw.handlers.set('session.create', () => ({ info: { stored_session_id: 's1' }, session_id: 's1', subscription_id: 'sub1' }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the connect card on the gateway wire', () => {
  it('a connection.request draws the card on the running tool row', async () => {
    const { call } = await waitingOnFigma()

    expect(call.outcome.kind).toBe('running')
    expect(call.connect).toMatchObject({ op: { id: 'op1', seq: 2, session: 's1', timeoutSeconds: 300 }, settled: undefined })
    expect(call.connect?.targets).toMatchObject([{ kind: 'connector', name: 'figma', state: 'initiated', title: 'Figma', url: FIGMA }])
    // The card stays out of the work group's fold while the tool runs.
    expect(ownsCard(call)).toBe(true)

    const drawn = view(call)
    expect(drawn).toContain('hermes.connect.row')
    expect(drawn).toContain('connect-open=op1:figma')
    expect(drawn).toContain('connect-skip=op1:figma')
    expect(drawn).toContain('connect-continue=op1')
    expect(drawn).toContain('up to 5 minutes')
  })

  it('Authorize opens the link and wakes the operation', async () => {
    const { call } = await waitingOnFigma()

    await click('connect-open', 'op1:figma')

    expect(browsed).toEqual([FIGMA])
    expect(call.connect?.opened).toEqual(['figma'])
    expect(gw.sent('connectors.operation.wake')).toEqual([{ op_id: 'op1', owner: OWNER }])
    expect(view(call)).toContain('waiting for your browser')
  })

  it('Skip and Continue answer through connection.respond, once per press in flight', async () => {
    await waitingOnFigma()
    let answer: (v: unknown) => void = () => undefined
    gw.handlers.set('connection.respond', () => new Promise(resolve => (answer = resolve)))

    await click('connect-skip', 'op1:figma')
    // A second press while the first is in flight sends nothing.
    await click('connect-skip', 'op1:figma')
    answer({ settled: false, status: 'ok' })
    await flush()
    gw.handlers.set('connection.respond', () => ({ settled: true, status: 'ok' }))
    await click('connect-continue', 'op1')

    expect(gw.sent('connection.respond')).toEqual([
      { op_id: 'op1', owner: OWNER, result: { targets: [{ name: 'figma', status: 'skipped' }] } },
      { op_id: 'op1', owner: OWNER, result: { settled_by: 'continue' } }
    ])
    // Nothing is sent to the agent: the tool returns by itself.
    expect(gw.sent('prompt.submit')).toEqual([])
  })

  it('connection.update moves the rows in seq order and settles the card', async () => {
    const { call } = await waitingOnFigma()

    gw.event(update(4, [figma('connected')]))
    expect(call.connect?.targets[0]?.state).toBe('connected')

    // A frame the transport delivered late, or twice, moves nothing back.
    gw.event(update(3, [figma('initiated')]))
    gw.event(update(4, [figma('failed')]))
    expect(call.connect).toMatchObject({ op: { seq: 4 }, targets: [{ state: 'connected', url: FIGMA }] })

    gw.event(update(5, [figma('connected')], { settled: true, settled_at: Date.now() / 1000, settled_by: 'all_resolved' }))
    expect(call.connect?.settled).toBe('all_resolved')
    // A settled card is a summary: no buttons, and nothing moves it again.
    gw.event(update(6, [figma('failed')]))
    expect(call.connect?.targets[0]?.state).toBe('connected')
    const drawn = view(call)
    expect(drawn).toContain('All connected.')
    expect(drawn).not.toContain('connect-')
  })

  it('Try again re-mints a failed link through connectors.connect and draws the reply', async () => {
    const { call } = await waitingOnFigma()
    gw.event(update(3, [figma('failed', { connect_url: null, detail: 'the link failed' })]))
    expect(view(call)).toContain('connect-retry=op1:figma')
    gw.handlers.set('connectors.connect', () => ({
      deadline_at: Date.now() / 1000 + 200,
      op_id: 'op1',
      seq: 4,
      settled: false,
      targets: [figma('initiated', { connect_url: 'https://portal/connect/figma-2' })]
    }))

    await click('connect-retry', 'op1:figma')

    expect(gw.sent('connectors.connect')).toEqual([{ connectors: ['figma'], owner: OWNER, reconnect: true }])
    expect(call.connect?.targets[0]).toMatchObject({ state: 'initiated', url: 'https://portal/connect/figma-2' })
  })

  it('an MCP row starts on Connect with its default credentials', async () => {
    const app = await started()
    gw.event({ payload: {}, session_id: 's1', type: 'message.start' })
    gw.event(toolStart('call_m'))
    const env = [{ default: 'https://x', name: 'LINEAR_URL', required: true, secret: false }]
    gw.event(request('op2', 'call_m', [{ action: 'install', kind: 'mcp', name: 'linear', required_env: env, state: 'pending' }]))
    await flush()

    expect(view(must(app.transcript.call(toolCallId('call_m'))))).toContain('connect-approve=op2:linear')
    await click('connect-approve', 'op2:linear')

    expect(gw.sent('connection.respond')).toEqual([
      { op_id: 'op2', owner: OWNER, result: { targets: [{ env: { LINEAR_URL: 'https://x' }, name: 'linear', status: 'approved' }] } }
    ])
  })

  it('the tool result settles a card whose settling frame never came', async () => {
    const { app, call } = await waitingOnFigma()
    const result = { op_id: 'op1', seq: 5, settled_at: Date.now() / 1000, settled_by: 'continue', status: 'settled', targets: [{ kind: 'connector', name: 'figma', state: 'not_connected' }] }

    gw.event({ payload: { name: 'manage_connections', result: JSON.stringify(result), tool_id: 'call_f' }, session_id: 's1', type: 'tool.complete' })
    await flush()

    expect(app.transcript.call(toolCallId('call_f'))?.connect).toMatchObject({ settled: 'continued', targets: [{ state: 'not_connected', url: FIGMA }] })
    expect(view(call)).not.toContain('connect-')
  })

  it('a typed message continues a card the tool waits on', async () => {
    const { app } = await waitingOnFigma()

    app.stores.composer.set('never mind, skip it')
    tern.press('enter')
    await flush()
    await flush()

    expect(gw.sent('connection.respond')).toEqual([{ op_id: 'op1', owner: OWNER, result: { settled_by: 'continue' } }])
  })

  it('a request with no tool row yet adds the row, and an operation the gateway dropped stops waiting', async () => {
    const app = await started()
    gw.handlers.set('connectors.operation.status', () => {
      throw Object.assign(new Error('No open operation with that op_id.'), { code: 4004 })
    })
    gw.event({ payload: {}, session_id: 's1', type: 'message.start' })
    gw.event(request('op3', 'call_x'))
    await flush()
    await flush()

    // The status read the draw polls with found no operation: the card is a summary.
    const call = must(app.transcript.call(toolCallId('call_x')))
    expect(call.name).toBe('manage_connections')
    expect(call.connect).toMatchObject({ op: { id: 'op3' }, settled: 'stopped' })
    expect(view(call)).toContain('Hermes stopped watching these links')
  })

  it('a request the pane cannot draw is a notice, and the tool is not left waiting', async () => {
    const app = await started()

    gw.event({ payload: { deadline_at: 1, display: { suggested: [] }, op_id: 'op4', seq: 1, targets: [], timeout_seconds: 300, tool_call_id: 'call_d' }, session_id: 's1', type: 'connection.request' })
    await flush()

    expect(JSON.stringify(app.transcript.entries)).toContain('cannot draw')
    expect(gw.sent('connection.respond')).toEqual([{ op_id: 'op4', owner: OWNER, result: { settled_by: 'continue' } }])
  })

  it('a resume restores the open card from pending_connection on its running call', async () => {
    const app = await started()
    gw.handlers.set('session.resume', p => ({
      info: { stored_session_id: p['session_id'] },
      messages: [{ role: 'user', text: 'connect figma', timestamp: Date.now() / 1000 }],
      pending_connection: request('op5', 'call_r', [figma('initiated')]).payload,
      running: true,
      session_id: p['session_id'],
      subscription_id: 'sub-again'
    }))

    gw.event({ payload: {}, type: 'gateway.ready' })
    await flush()
    await flush()

    // The history lacks the running call: the card comes back on a row of its own.
    const call = must(app.transcript.call(toolCallId('call_r')))
    expect(call.outcome.kind).toBe('running')
    expect(call.connect).toMatchObject({ op: { id: 'op5', session: 's1' }, targets: [{ state: 'initiated', url: FIGMA }] })
    expect(view(call)).toContain('connect-open=op5:figma')

    // The request held across the switch lands after the snapshot: it is a frame of the same card.
    gw.event(update(3, [figma('connected')], {}, 'op5'))
    expect(call.connect?.targets[0]?.state).toBe('connected')
  })

  it('a card file still draws, and its Continue still tells the agent', async () => {
    const dir = join(home, 'plugin-data', 'hermes-tern', 'connections')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'call_o.op9.json'),
      JSON.stringify({ pid: process.pid, settled_by: null, targets: [{ connect_url: 'https://portal/x', name: 'googledrive', state: 'initiated' }], updated_at: Date.now() / 1000, watching: true })
    )
    const app = await started()
    const result = { op_id: 'op9', status: 'initiated', targets: [{ name: 'googledrive', state: 'initiated' }] }
    gw.event({ payload: { name: 'manage_connections', result: JSON.stringify(result), tool_id: 'call_o' }, session_id: 's1', type: 'tool.complete' })
    await flush()

    const call = must(app.transcript.call(toolCallId('call_o')))
    expect(call.connect).toMatchObject({ key: 'call_o.op9' })
    expect(call.connect?.op).toBeUndefined()
    expect(view(call)).toContain('connect-open=call_o.op9:googledrive')
    expect(view(call)).not.toContain('connect-skip')

    await click('connect-continue', 'call_o.op9')

    expect(gw.sent('connection.respond')).toEqual([])
    expect(gw.sent('prompt.submit').map(p => p['text'])).toEqual(["I've authorized Google Drive. Check with manage_connections status and carry on."])
  })
})
