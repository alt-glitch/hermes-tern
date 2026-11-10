// The connect card on the shared gateway's own wire (connections/live.ts): `connection.request`
// draws it on the running tool row, its buttons answer through `connection.respond`,
// `connectors.operation.wake` and `connectors.connect`, `connection.update` frames move its rows in
// seq order, and a resume's `pending_connection` brings it back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { toolCallId } from '../core/ids.js'
import type { TranscriptContext } from '../view/transcript.js'

import { connectionFixture, FIGMA, figma, flush, OWNER, request, toolStart, update, view } from './appSetup.js'
import { must } from './fakes.js'

/** The links the app opened in the browser. */
const browsed = vi.hoisted((): string[] => [])

vi.mock('../overlays/pullRequests.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../overlays/pullRequests.js')>()),
  openUrl: (url: string) => void browsed.push(url)
}))
const { ownsCard } = await import('../view/workLogModel.js')
const { entryNode } = await import('../view/transcript.js')

let fixture: ReturnType<typeof connectionFixture>

beforeEach(() => {
  browsed.length = 0
  fixture = connectionFixture()
})

afterEach(async () => {
  await fixture.dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the connect card on the gateway wire', () => {
  it('a connection.request draws the card on the running tool row', async () => {
    const { call } = await fixture.waitingOnFigma()

    expect(call.outcome.kind).toBe('running')
    expect(call.connect).toMatchObject({ op: { id: 'op1', seq: 2, session: 's1' }, settled: undefined })
    expect(call.connect?.targets).toMatchObject([{ kind: 'connector', name: 'figma', state: 'initiated', title: 'Figma', url: FIGMA }])
    // The card stays out of the work group's fold while the tool runs.
    expect(ownsCard(call)).toBe(true)

    const drawn = view(call)
    expect(drawn).toContain('hermes.connect.row')
    expect(drawn).toContain('connect-open=op1:figma')
    expect(drawn).toContain('connect-skip=op1:figma')
    expect(drawn).toContain('connect-continue=op1')
    expect(drawn).toContain('Not now')
    // The wait counts down from the gateway's deadline (300 s ahead here).
    expect(drawn).toContain('Hermes waits up to 5 more minutes.')
  })

  it('an update that beats its request draws the card, and the wait still comes from the deadline', async () => {
    const app = await fixture.started()
    fixture.gw.event({ payload: {}, session_id: 's1', type: 'message.start' })
    fixture.gw.event(toolStart())
    // The gateway's first row change is published before connection.request (local_desktop_ui.py).
    const deadline = { deadline_at: Date.now() / 1000 + 600 }
    fixture.gw.event(update(1, [figma('initiated')], deadline))
    fixture.gw.event({ ...request(), payload: { ...request().payload, ...deadline, seq: 1, timeout_seconds: 600 } })
    await flush()

    const call = must(app.transcript.call(toolCallId('call_f')))
    expect(call.connect).toMatchObject({ op: { id: 'op1', seq: 1 } })
    expect(view(call)).toContain('Hermes waits up to 10 more minutes.')
  })

  it('no Thinking line runs under a card the tool waits on', async () => {
    const { app, call } = await fixture.waitingOnFigma()
    const cx: TranscriptContext = { copy: () => undefined, now: Date.now(), welcome: { version: '' } }
    const turn = () => JSON.stringify(entryNode(must(app.transcript.entries.findLast(e => e.kind === 'turn')), 'main.t', cx))

    expect(turn()).not.toContain('"t":"Thinking"')

    // Settled, the model runs again: Thinking carries the turn.
    fixture.gw.event(update(3, [figma('skipped')], { settled: true, settled_at: Date.now() / 1000, settled_by: 'all_resolved' }))
    expect(call.connect?.settled).toBe('all_resolved')
    expect(turn()).toContain('"t":"Thinking"')
  })

  it('Authorize opens the link and wakes the operation', async () => {
    const { call } = await fixture.waitingOnFigma()

    await fixture.click('connect-open', 'op1:figma')

    expect(browsed).toEqual([FIGMA])
    expect(call.connect?.opened).toEqual(['figma'])
    expect(fixture.gw.sent('connectors.operation.wake')).toEqual([{ op_id: 'op1', owner: OWNER }])
    expect(view(call)).toContain('waiting for your browser')
  })

  it('Skip and Continue answer through connection.respond, once per press in flight', async () => {
    await fixture.waitingOnFigma()
    let answer: (v: unknown) => void = () => undefined
    fixture.gw.handlers.set('connection.respond', () => new Promise(resolve => (answer = resolve)))

    await fixture.click('connect-skip', 'op1:figma')
    // A second press while the first is in flight sends nothing.
    await fixture.click('connect-skip', 'op1:figma')
    answer({ settled: false, status: 'ok' })
    await flush()
    fixture.gw.handlers.set('connection.respond', () => ({ settled: true, status: 'ok' }))
    await fixture.click('connect-continue', 'op1')

    expect(fixture.gw.sent('connection.respond')).toEqual([
      { op_id: 'op1', owner: OWNER, result: { targets: [{ name: 'figma', status: 'skipped' }] } },
      { op_id: 'op1', owner: OWNER, result: { settled_by: 'continue' } }
    ])
    // Nothing is sent to the agent: the tool returns by itself.
    expect(fixture.gw.sent('prompt.submit')).toEqual([])
  })

  it('connection.update moves the rows in seq order and settles the card', async () => {
    const { call } = await fixture.waitingOnFigma()

    fixture.gw.event(update(4, [figma('connected')]))
    expect(call.connect?.targets[0]?.state).toBe('connected')

    // A frame the transport delivered late, or twice, moves nothing back.
    fixture.gw.event(update(3, [figma('initiated')]))
    fixture.gw.event(update(4, [figma('failed')]))
    expect(call.connect).toMatchObject({ op: { seq: 4 }, targets: [{ state: 'connected', url: FIGMA }] })

    fixture.gw.event(update(5, [figma('connected')], { settled: true, settled_at: Date.now() / 1000, settled_by: 'all_resolved' }))
    expect(call.connect?.settled).toBe('all_resolved')
    // A settled card is a summary: no buttons, and nothing moves it again.
    fixture.gw.event(update(6, [figma('failed')]))
    expect(call.connect?.targets[0]?.state).toBe('connected')
    const drawn = view(call)
    expect(drawn).toContain('App connected')
    expect(drawn).not.toContain('connect-')
    // Every app resolved: the summary needs no line under it.
    expect(drawn).not.toContain('hermes.connect.note')
  })

  it('Try again re-mints a failed link through connectors.connect and draws the reply', async () => {
    const { call } = await fixture.waitingOnFigma()
    fixture.gw.event(update(3, [figma('failed', { connect_url: null, detail: 'the link failed' })]))
    expect(view(call)).toContain('connect-retry=op1:figma')
    fixture.gw.handlers.set('connectors.connect', () => ({
      deadline_at: Date.now() / 1000 + 200,
      op_id: 'op1',
      seq: 4,
      settled: false,
      targets: [figma('initiated', { connect_url: 'https://portal/connect/figma-2' })]
    }))

    await fixture.click('connect-retry', 'op1:figma')

    expect(fixture.gw.sent('connectors.connect')).toEqual([{ connectors: ['figma'], owner: OWNER, reconnect: true }])
    expect(call.connect?.targets[0]).toMatchObject({ state: 'initiated', url: 'https://portal/connect/figma-2' })
  })

  it('a Try again in flight says so, and the row takes no other answer meanwhile', async () => {
    const { call } = await fixture.waitingOnFigma()
    fixture.gw.event(update(3, [figma('failed', { connect_url: null, detail: 'the link failed' })]))
    let reply: (v: unknown) => void = () => undefined
    fixture.gw.handlers.set('connectors.connect', () => new Promise(resolve => (reply = resolve)))

    await fixture.click('connect-retry', 'op1:figma')
    const busy = view(call)
    expect(busy).toContain('Retrying…')
    expect(busy).not.toContain('connect-retry=op1:figma')
    expect(busy).not.toContain('connect-skip=op1:figma')
    // A Skip that slipped through (a stale frame's button) waits too.
    await fixture.click('connect-skip', 'op1:figma')
    expect(fixture.gw.sent('connection.respond')).toEqual([])

    reply({ deadline_at: Date.now() / 1000 + 200, op_id: 'op1', seq: 4, settled: false, targets: [figma('initiated', { connect_url: 'https://portal/connect/figma-2' })] })
    await flush()
    await flush()
    expect(call.connect?.sending).toBeUndefined()
    expect(view(call)).toContain('connect-open=op1:figma')
  })

  it('an MCP row starts on Connect with its default credentials', async () => {
    const app = await fixture.started()
    fixture.gw.event({ payload: {}, session_id: 's1', type: 'message.start' })
    fixture.gw.event(toolStart('call_m'))
    const env = [{ default: 'https://x', name: 'LINEAR_URL', required: true, secret: false }]
    fixture.gw.event(request('op2', 'call_m', [{ action: 'install', kind: 'mcp', name: 'linear', required_env: env, state: 'pending' }]))
    await flush()

    expect(view(must(app.transcript.call(toolCallId('call_m'))))).toContain('connect-approve=op2:linear')
    await fixture.click('connect-approve', 'op2:linear')

    expect(fixture.gw.sent('connection.respond')).toEqual([
      { op_id: 'op2', owner: OWNER, result: { targets: [{ env: { LINEAR_URL: 'https://x' }, name: 'linear', status: 'approved' }] } }
    ])
  })

  it('the tool result settles a card whose settling frame never came', async () => {
    const { app, call } = await fixture.waitingOnFigma()
    const result = { op_id: 'op1', seq: 5, settled_at: Date.now() / 1000, settled_by: 'continue', status: 'settled', targets: [{ kind: 'connector', name: 'figma', state: 'not_connected' }] }

    fixture.gw.event({ payload: { name: 'manage_connections', result: JSON.stringify(result), tool_id: 'call_f' }, session_id: 's1', type: 'tool.complete' })
    await flush()

    expect(app.transcript.call(toolCallId('call_f'))?.connect).toMatchObject({ settled: 'continued', targets: [{ state: 'not_connected', url: FIGMA }] })
    expect(view(call)).not.toContain('connect-')
  })

  it('a settled result draws the summary on a call that never had a card', async () => {
    const app = await fixture.started()
    fixture.gw.event({ payload: {}, session_id: 's1', type: 'message.start' })
    fixture.gw.event(toolStart('call_s'))
    const result = { op_id: 'op8', seq: 3, settled_at: Date.now() / 1000, settled_by: 'all_resolved', status: 'settled', targets: [{ kind: 'connector', name: 'figma', state: 'skipped' }] }
    fixture.gw.event({ payload: { name: 'manage_connections', result: JSON.stringify(result), tool_id: 'call_s' }, session_id: 's1', type: 'tool.complete' })
    await flush()
    await flush()

    const call = must(app.transcript.call(toolCallId('call_s')))
    // The summary is read from the result each draw; the watcher holds no card for it.
    expect(call.connect).toBeUndefined()
    expect(ownsCard(call)).toBe(true)
    const drawn = view(call)
    expect(drawn).toContain('skipped')
    expect(drawn).not.toContain('connect-')
  })

  it('an MCP row shows what Connect runs before the user approves it', async () => {
    const app = await fixture.started()
    fixture.gw.event({ payload: {}, session_id: 's1', type: 'message.start' })
    fixture.gw.event(toolStart('call_m'))
    const launch = { cwd: '/tmp/work', env: ['LINEAR_URL'], kind: 'stdio', target: 'npx -y @linear/mcp --port 3000' }
    fixture.gw.event(request('op6', 'call_m', [{ action: 'install', kind: 'mcp', launch, name: 'linear', state: 'pending' }]))
    await flush()

    const call = must(app.transcript.call(toolCallId('call_m')))
    const drawn = view(call)
    expect(drawn).toContain('Runs: npx -y @linear/mcp --port 3000')
    expect(drawn).toContain('Working dir: /tmp/work')
    expect(drawn).toContain('Env: LINEAR_URL')

    // Resolved, the line goes: there is nothing left to consent to.
    fixture.gw.event(update(3, [{ action: 'install', kind: 'mcp', launch, name: 'linear', state: 'connected' }], {}, 'op6'))
    expect(view(call)).not.toContain('Runs:')
  })

  it('a request naming a finished call of the same id gets a row of its own', async () => {
    const app = await fixture.started()
    fixture.gw.event({ payload: {}, session_id: 's1', type: 'message.start' })
    fixture.gw.event(toolStart())
    fixture.gw.event({ payload: { name: 'manage_connections', result: '{"status": "ok"}', tool_id: 'call_f' }, session_id: 's1', type: 'tool.complete' })
    await flush()

    // A later turn's call reused the id: its card must not land on the finished row.
    fixture.gw.event(request('op7', 'call_f'))
    await flush()

    expect(app.transcript.call(toolCallId('call_f'))?.connect).toBeUndefined()
    expect(app.transcript.call(toolCallId('connect-op7'))?.connect).toMatchObject({ op: { id: 'op7' }, settled: undefined })
  })

  it("the tool's result replaces a stop the pane inferred from a 4004", async () => {
    const { app, call } = await fixture.waitingOnFigma()
    fixture.gw.handlers.set('connectors.operation.status', () => {
      throw Object.assign(new Error('No open operation with that op_id.'), { code: 4004 })
    })
    app.stores.connect.watch()
    await flush()
    await flush()
    expect(call.connect?.settled).toBe('stopped')

    // The gateway dropped the operation just before the tool returned; the result says how it ended.
    const result = { op_id: 'op1', seq: 5, settled_at: Date.now() / 1000, settled_by: 'continue', status: 'settled', targets: [{ kind: 'connector', name: 'figma', state: 'skipped' }] }
    fixture.gw.event({ payload: { name: 'manage_connections', result: JSON.stringify(result), tool_id: 'call_f' }, session_id: 's1', type: 'tool.complete' })
    await flush()
    await flush()

    expect(call.connect).toMatchObject({ settled: 'continued', targets: [{ state: 'skipped', url: FIGMA }] })
    expect(view(call)).not.toContain('stopped watching')
  })

  it('the wait redraws as its minutes count down', async () => {
    const { app, call } = await fixture.waitingOnFigma()
    const start = Date.now()
    const cx = (now: number): TranscriptContext => ({ copy: () => undefined, now, welcome: { version: '' } })
    const turn = (now: number) => JSON.stringify(entryNode(must(app.transcript.entries.findLast(e => e.kind === 'turn')), 'main.t', cx(now)))
    fixture.gw.handlers.set('connectors.operation.status', () => ({ deadline_at: start / 1000 + 300, op_id: 'op1', seq: 2, settled: false, targets: [figma('initiated')] }))

    app.stores.connect.watch()
    await flush()
    expect(turn(start)).toContain('up to 5 more minutes')
    expect(call.connect?.settled).toBeUndefined()

    // Two minutes on, nothing about the card changed but its countdown.
    vi.spyOn(Date, 'now').mockReturnValue(start + 121_000)
    app.stores.connect.watch()
    await flush()
    expect(turn(start + 121_000)).toContain('up to 3 more minutes')
  })

  it('a typed message continues a card the tool waits on', async () => {
    const { app } = await fixture.waitingOnFigma()

    app.stores.composer.set('never mind, skip it')
    fixture.tern.press('enter')
    await flush()
    await flush()

    expect(fixture.gw.sent('connection.respond')).toEqual([{ op_id: 'op1', owner: OWNER, result: { settled_by: 'continue' } }])
  })

  it('a request with no tool row yet adds the row, and an operation the gateway dropped stops waiting', async () => {
    const app = await fixture.started()
    fixture.gw.handlers.set('connectors.operation.status', () => {
      throw Object.assign(new Error('No open operation with that op_id.'), { code: 4004 })
    })
    fixture.gw.event({ payload: {}, session_id: 's1', type: 'message.start' })
    fixture.gw.event(request('op3', 'call_x'))
    await flush()
    await flush()

    // The status read the draw polls with found no operation: the card is a summary.
    const call = must(app.transcript.call(toolCallId('call_x')))
    expect(call.name).toBe('manage_connections')
    expect(call.connect).toMatchObject({ op: { id: 'op3' }, settled: 'stopped' })
    expect(view(call)).toContain('Hermes stopped watching these links')
  })

  it('a request the pane cannot draw is a notice, and the tool is not left waiting', async () => {
    const app = await fixture.started()

    fixture.gw.event({ payload: { deadline_at: 1, display: { suggested: [] }, op_id: 'op4', seq: 1, targets: [], timeout_seconds: 300, tool_call_id: 'call_d' }, session_id: 's1', type: 'connection.request' })
    await flush()

    expect(JSON.stringify(app.transcript.entries)).toContain('cannot draw')
    expect(fixture.gw.sent('connection.respond')).toEqual([{ op_id: 'op4', owner: OWNER, result: { settled_by: 'continue' } }])
  })

  it('a resume restores the open card from pending_connection on its running call', async () => {
    const app = await fixture.started()
    const tipOwner = { session_id: 'resumed-tip', type: 'session' }
    fixture.gw.handlers.set('session.resume', () => ({
      info: { stored_session_id: 's1' },
      messages: [{ role: 'user', text: 'connect figma', timestamp: Date.now() / 1000 }],
      pending_connection: { ...request('op5', 'call_r', [figma('initiated')]).payload, owner: tipOwner },
      running: true,
      session_id: 'resumed-tip',
      subscription_id: 'sub-again'
    }))

    fixture.gw.event({ payload: {}, type: 'gateway.ready' })
    await flush()
    await flush()

    // The history lacks the running call: the card comes back on a row of its own.
    const call = must(app.transcript.call(toolCallId('call_r')))
    expect(call.outcome.kind).toBe('running')
    expect(app.session.ref).toEqual({ live: 'resumed-tip', stored: 's1' })
    expect(call.connect).toMatchObject({ op: { id: 'op5', session: 'resumed-tip' }, targets: [{ state: 'initiated', url: FIGMA }] })
    expect(view(call)).toContain('connect-open=op5:figma')

    await fixture.click('connect-open', 'op5:figma')
    await fixture.click('connect-skip', 'op5:figma')
    expect(browsed).toEqual([FIGMA])
    expect(fixture.gw.sent('connectors.operation.wake')).toEqual([{ op_id: 'op5', owner: tipOwner }])
    expect(fixture.gw.sent('connection.respond')).toEqual([
      { op_id: 'op5', owner: tipOwner, result: { targets: [{ name: 'figma', status: 'skipped' }] } }
    ])
    // A compressed conversation's runtime tip owns the update, not its stored root.
    fixture.gw.event({ ...update(3, [figma('connected')], { owner: tipOwner }, 'op5'), session_id: 'resumed-tip' })
    expect(call.connect?.targets[0]?.state).toBe('connected')
    expect(fixture.gw.sent('prompt.submit')).toEqual([])
  })

  it('a result with links and no operation is a plain tool row: no card, no buttons, nothing sent', async () => {
    const app = await fixture.started()
    const result = { op_id: 'op9', status: 'initiated', targets: [{ connect_url: 'https://portal/x', name: 'googledrive', state: 'initiated' }] }
    fixture.gw.event({ payload: { name: 'manage_connections', result: JSON.stringify(result), tool_id: 'call_o' }, session_id: 's1', type: 'tool.complete' })
    await flush()

    const call = must(app.transcript.call(toolCallId('call_o')))
    expect(call.connect).toBeUndefined()
    expect(ownsCard(call)).toBe(false)
    expect(view(call)).not.toContain('connect-')
    expect(fixture.gw.sent('connection.respond')).toEqual([])
    expect(fixture.gw.sent('prompt.submit')).toEqual([])
  })

})
