// The gateway connection: `hermes gateway attach --json` per dial (hermes/connect.ts), and the
// skin colors tern derives itself (hermes/theme.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { toolCallId } from '../core/ids.js'
import { AttachError, attachGateway, type Ran, readHermesCommand, terminalAttachFailure } from '../hermes/connect.js'
import { skinColors } from '../hermes/theme.js'

import { connectionFixture, FIGMA, figma, flush, OWNER, request, toolStart, update, view } from './appSetup.js'
import { FakeGateway, must } from './fakes.js'

/** The links the app opened in the browser. */
const browsed = vi.hoisted((): string[] => [])

vi.mock('../overlays/pullRequests.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../overlays/pullRequests.js')>()),
  openUrl: (url: string) => void browsed.push(url)
}))
const { ownsCard } = await import('../view/workLogModel.js')

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

const HERMES = { argv: ['/py', '-m', 'hermes_cli.main'] as const, env: { PYTHONPATH: '/src' } }

const GRANT = {
  endpoint: { instance_id: 'inst-1', profile_id: 'default' },
  protocol: 'hermes-gateway-v1',
  protocols: ['hermes-gateway-v1', 'hermes-gateway-ticket.t1'],
  reason_code: null,
  state: 'ready',
  ticket: 't1',
  url: 'ws://127.0.0.1:9000/api/ws'
}

/** A runner answering with `ran`; records each command and its environment. */
function runner(ran: Partial<Ran>) {
  const calls: { file: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = []

  return {
    calls,
    run: async (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => (calls.push({ args, env, file }), { code: 0, stderr: '', stdout: '', ...ran })
  }
}

describe('attachGateway', () => {
  it('runs attach with --start first and --recover when asked, and maps the grant', async () => {
    const r = runner({ stdout: `${JSON.stringify(GRANT)}\n` })
    const connect = attachGateway(HERMES, r.run, { HOME: '/me', PYTHONPATH: '/old' })

    expect(await connect(true, false)).toEqual({ instance_id: 'inst-1', profile_id: 'default', protocols: GRANT.protocols, url: GRANT.url })
    await connect(false, true)
    await connect(false, false)
    expect(r.calls.map(c => [c.file, ...c.args].join(' '))).toEqual([
      '/py -m hermes_cli.main gateway attach --json --start',
      '/py -m hermes_cli.main gateway attach --json --recover',
      '/py -m hermes_cli.main gateway attach --json'
    ])
    expect(r.calls[0]?.env).toMatchObject({ HOME: '/me', PYTHONPATH: '/src' })
  })

  it("throws attach's own verdict, terminal only for what no retry fixes", async () => {
    const verdict = { message: 'gateway incompatible: runtime_protocol\ngateway incompatible: run hermes update', state: 'incompatible' }
    const incompatible = attachGateway(HERMES, runner({ code: 3, stdout: JSON.stringify(verdict) }).run)
    const error = await incompatible(true, false).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AttachError)
    expect(terminalAttachFailure(error instanceof Error ? error : new Error())).toBe('gateway incompatible: runtime_protocol')

    const draining = attachGateway(HERMES, runner({ code: 6, stdout: JSON.stringify({ message: 'gateway draining: restart_wait' }) }).run)
    const busy = await draining(false, false).catch((e: unknown) => e)
    expect(busy instanceof Error && busy.message).toBe('gateway draining: restart_wait')
    expect(terminalAttachFailure(busy instanceof Error ? busy : new Error())).toBeUndefined()
  })

  it('names an older Hermes without the attach command, and a reply it cannot read', async () => {
    const old = attachGateway(HERMES, runner({ code: 2, stderr: "hermes gateway: 'attach' is not a `hermes gateway` command." }).run)
    await expect(old(true, false)).rejects.toThrow('this Hermes has no `hermes gateway attach`; run `hermes update`')

    const garbled = attachGateway(HERMES, runner({ stdout: 'not json' }).run)
    await expect(garbled(true, false)).rejects.toThrow('hermes gateway attach exited 0')
  })
})

describe('readHermesCommand', () => {
  it('reads the launcher command, and nothing from a missing or broken one', () => {
    expect(readHermesCommand(JSON.stringify(HERMES))).toEqual({ argv: ['/py', '-m', 'hermes_cli.main'], env: { PYTHONPATH: '/src' } })
    expect(readHermesCommand('{"argv":["/py"]}')).toEqual({ argv: ['/py'], env: {} })
    expect(readHermesCommand(undefined)).toBeUndefined()
    expect(readHermesCommand('{"argv":[]}')).toBeUndefined()
    expect(readHermesCommand('nope')).toBeUndefined()
  })
})

describe('skinColors', () => {
  it("takes the skin's tokens, else Hermes' default seeds for the polarity", () => {
    expect(skinColors({}, 'dark')).toEqual({ accent: '#FFBF00', error: '#ef5350', ok: '#4caf50', warn: '#ffa726' })
    expect(skinColors({ banner_accent: '#3366ff', ui_ok: '#00aa00' }, 'dark')).toMatchObject({ accent: '#3366ff', ok: '#00aa00' })
    expect(skinColors({ ui_accent: '#112233', banner_accent: '#3366ff' }, 'light').accent).not.toBe('#3366ff')
  })

  it('lifts a color that would not read on the background', () => {
    const lifted = skinColors({ ui_error: '#120000' }, 'dark').error

    expect(lifted).not.toBe('#120000')
  })
})

describe('connection operation ownership and lifecycle', () => {
  it('link-shaped JSON from another tool never opens or answers a connection card', async () => {
    const app = await fixture.started()
    fixture.gw.event({ payload: {}, session_id: 's1', type: 'message.start' })
    const result = {
      op_id: 'foreign-op', seq: 5, status: 'settled', settled_at: Date.now() / 1000, settled_by: 'continue',
      targets: [figma('initiated')]
    }
    fixture.gw.event({ payload: { name: 'terminal', tool_id: 'call_other', result: JSON.stringify(result) }, session_id: 's1', type: 'tool.complete' })
    await flush()
    await flush()

    const call = must(app.transcript.call(toolCallId('call_other')))
    expect(call.connect).toBeUndefined()
    expect(ownsCard(call)).toBe(false)
    expect(view(call)).not.toContain('hermes.connect.row')
    expect(view(call)).not.toContain('connect-')
    expect(fixture.gw.sent('connection.respond')).toEqual([])
    expect(fixture.gw.sent('connectors.operation.status')).toEqual([])
    expect(fixture.gw.sent('prompt.submit')).toEqual([])
  })

  it('disposal stops polling and fences a late status reply from this and the next fixture', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const { app, call } = await fixture.waitingOnFigma()
    const previousGateway = fixture.gw
    const reply = Promise.withResolvers<unknown>()
    previousGateway.handlers.set('connectors.operation.status', () => reply.promise)
    const beforePoll = previousGateway.sent('connectors.operation.status').length
    app.stores.connect.watch()
    await flush()
    await flush()
    expect(previousGateway.sent('connectors.operation.status').length).toBeGreaterThan(beforePoll)
    app.quit()
    await must(fixture.running.get(app))
    fixture.running.delete(app)
    const requestsAtDispose = previousGateway.sent('connectors.operation.status').length
    const disposedCard = structuredClone(call.connect)

    fixture.gw = new FakeGateway({ replies: {
      'setup.status': () => ({ provider_configured: true }),
      'session.create': () => ({ info: { stored_session_id: 's1' }, session_id: 's1', subscription_id: 'next-sub' })
    } })
    const next = await fixture.waitingOnFigma()
    const nextCard = structuredClone(next.call.connect)
    reply.resolve(update(9, [figma('connected')], { settled: true, settled_at: Date.now() / 1000, settled_by: 'all_resolved' }).payload)
    await flush()
    await vi.advanceTimersByTimeAsync(10_000)
    await flush()

    expect(previousGateway.sent('connectors.operation.status')).toHaveLength(requestsAtDispose)
    expect(call.connect).toEqual(disposedCard)
    expect(call.connect?.targets[0]?.state).toBe('initiated')
    expect(next.call.connect).toEqual(nextCard)
    expect(view(next.call)).not.toContain('App connected')
    expect(next.call.connect).toMatchObject({ op: { id: 'op1', seq: 2 }, settled: undefined, targets: [{ state: 'initiated' }] })
    expect(fixture.gw.sent('connection.respond')).toEqual([])
    expect(fixture.gw.sent('prompt.submit')).toEqual([])
  })

  it('three target rows move independently, retain their URLs, and settle under one operation', async () => {
    const slack = (state: string, url: string | null = 'https://portal/connect/slack') => figma(state, { name: 'slack', connect_url: url })
    const drive = (url: string | null = 'https://portal/connect/drive') => figma('connected', { name: 'googledrive', connect_url: url })
    const { call } = await fixture.waitingOnFigma([figma('initiated'), slack('initiated'), drive()])
    expect(call.connect?.op).toMatchObject({ id: 'op1', session: 's1' })
    expect(call.connect?.targets.map(t => [t.name, t.state])).toEqual([
      ['figma', 'initiated'], ['slack', 'initiated'], ['googledrive', 'connected']
    ])
    await fixture.click('connect-open', 'op1:figma')
    await fixture.click('connect-open', 'op1:slack')
    expect(browsed).toEqual([FIGMA, 'https://portal/connect/slack'])

    fixture.gw.event(update(3, [figma('connected', { connect_url: null }), slack('initiated', null), drive(null)]))
    expect(call.connect?.targets).toMatchObject([
      { name: 'figma', state: 'connected', url: FIGMA },
      { name: 'slack', state: 'initiated', url: 'https://portal/connect/slack' },
      { name: 'googledrive', state: 'connected', url: 'https://portal/connect/drive' }
    ])
    expect(call.connect?.settled).toBeUndefined()
    expect(view(call)).toContain('connect-open=op1:slack')
    expect(view(call)).not.toContain('connect-open=op1:figma')
    fixture.gw.event(update(99, [figma('failed')], { settled: true, settled_at: Date.now() / 1000, settled_by: 'all_resolved' }, 'another-operation'))
    expect(call.connect?.op).toMatchObject({ id: 'op1', seq: 3 })
    expect(call.connect?.targets).toHaveLength(3)

    fixture.gw.event(update(4, [figma('connected', { connect_url: null }), slack('connected', null), drive(null)], {
      settled: true, settled_at: Date.now() / 1000, settled_by: 'all_resolved'
    }))
    expect(call.connect?.settled).toBe('all_resolved')
    expect(call.connect?.targets.map(t => t.url)).toEqual([FIGMA, 'https://portal/connect/slack', 'https://portal/connect/drive'])
    expect(view(call)).not.toContain('connect-')
    expect(view(call)).toContain('Apps connected')
    expect(fixture.gw.sent('connection.respond')).toEqual([])
    expect(fixture.gw.sent('prompt.submit')).toEqual([])
  })

  it('a reconnect stays initiated when its operation status is unchanged', async () => {
    const { app, call } = await fixture.waitingOnFigma()
    fixture.gw.event(update(3, [figma('expired')]))
    const snapshot = update(4, [figma('initiated', { alias: 'work account' })]).payload
    fixture.gw.handlers.set('connectors.connect', () => snapshot)
    await fixture.click('connect-retry', 'op1:figma')
    expect(fixture.gw.sent('connectors.connect')).toEqual([{ connectors: ['figma'], owner: OWNER, reconnect: true }])
    fixture.gw.handlers.set('connectors.operation.status', () => snapshot)
    app.stores.connect.watch()
    await flush()
    await flush()

    expect(fixture.gw.sent('connectors.operation.status')).toContainEqual({ op_id: 'op1', owner: OWNER })
    expect(call.connect).toMatchObject({ op: { seq: 4 }, settled: undefined, targets: [{ state: 'initiated', alias: 'work account' }] })
    expect(view(call)).toContain('needs authorizing')
    expect(view(call)).not.toContain('App connected')
    expect(fixture.gw.calls.filter(c => c.method.startsWith('connectors.')).map(c => c.method)).toEqual(
      expect.arrayContaining(['connectors.connect', 'connectors.operation.status'])
    )
    expect(fixture.gw.calls.filter(c => c.method.startsWith('connectors.') && !['connectors.connect', 'connectors.operation.status'].includes(c.method))).toEqual([])
    expect(fixture.gw.sent('prompt.submit')).toEqual([])
  })

  it('only the newer connected operation snapshot completes the reconnect account row', async () => {
    const { call } = await fixture.waitingOnFigma([figma('initiated', { action: 'reconnect', alias: 'new account' })])
    fixture.gw.event(update(3, [figma('initiated', { alias: 'new account' })]))
    expect(call.connect?.targets[0]).toMatchObject({ state: 'initiated', alias: 'new account' })
    expect(view(call)).not.toContain('App connected')
    fixture.gw.event(update(4, [figma('connected', { alias: 'new account', connect_url: null })]))
    expect(call.connect?.targets[0]).toMatchObject({ state: 'connected', alias: 'new account', url: FIGMA })
    expect(view(call)).toContain('App connected')
    expect(view(call)).toContain('new account')
    fixture.gw.event(update(3, [figma('initiated')]))
    expect(call.connect?.targets[0]?.state).toBe('connected')
    expect(fixture.gw.sent('prompt.submit')).toEqual([])
  })

  it.each(['expired', 'failed'])('a pending reconnect does not become %s before the gateway says so', async state => {
    const { app, call } = await fixture.waitingOnFigma([figma('initiated', { action: 'reconnect', alias: 'existing account' })])
    const snapshot = update(2, [figma('initiated', { alias: 'existing account' })]).payload
    fixture.gw.handlers.set('connectors.operation.status', () => snapshot)
    app.stores.connect.watch()
    await flush()
    expect(call.connect).toMatchObject({ settled: undefined, targets: [{ state: 'initiated' }] })
    expect(view(call)).not.toContain('link expired')
    expect(view(call)).not.toContain('connect-retry=')
    fixture.gw.event(update(3, [figma(state, { detail: 'gateway reported this result' })], {
      settled: true, settled_at: Date.now() / 1000, settled_by: 'all_resolved'
    }))
    expect(call.connect?.targets[0]?.state).toBe(state)
    expect(call.connect?.settled).toBe('all_resolved')
    expect(view(call)).toContain(state === 'expired' ? 'link expired' : 'failed')
    expect(view(call)).not.toContain('connect-')
    expect(fixture.gw.sent('prompt.submit')).toEqual([])
  })

  it('an older connected account operation cannot complete the new account operation', async () => {
    const { app, call: older } = await fixture.waitingOnFigma([figma('connected', { alias: 'existing account' })])
    fixture.gw.event(update(3, [figma('connected', { alias: 'existing account' })], {
      settled: true, settled_at: Date.now() / 1000, settled_by: 'all_resolved'
    }))
    fixture.gw.event(toolStart('call_new'))
    fixture.gw.event(request('op-new', 'call_new', [figma('initiated', { alias: 'second account', connect_url: 'https://portal/connect/new' })]))
    await flush()
    const newer = must(app.transcript.call(toolCallId('call_new')))
    expect(older.connect?.op?.id).toBe('op1')
    expect(newer.connect).toMatchObject({ op: { id: 'op-new', seq: 2 }, settled: undefined, targets: [{ state: 'initiated', alias: 'second account' }] })
    fixture.gw.event(update(99, [figma('connected')]))
    expect(newer.connect?.targets[0]?.state).toBe('initiated')
    expect(view(newer)).not.toContain('App connected')
    fixture.gw.event(update(3, [figma('connected', { alias: 'second account', connect_url: null })], {
      settled: true, settled_at: Date.now() / 1000, settled_by: 'all_resolved'
    }, 'op-new'))
    expect(newer.connect?.targets[0]).toMatchObject({ state: 'connected', url: 'https://portal/connect/new' })
    expect(view(newer)).toContain('App connected')
    expect(view(newer)).not.toContain('connect-')
    expect(fixture.gw.sent('prompt.submit')).toEqual([])
  })

  it.each(['empty', 'error'])('an %s status reply cannot invent a connected account', async reply => {
    const { app, call } = await fixture.waitingOnFigma([figma('initiated', { action: 'reconnect' })])
    fixture.gw.handlers.set('connectors.operation.status', () => {
      if (reply === 'error') {
        throw new Error('temporary operation status outage')
      }
      return {}
    })
    app.stores.connect.watch()
    await flush()
    await flush()
    expect(call.connect).toMatchObject({ settled: undefined, targets: [{ state: 'initiated' }] })
    expect(view(call)).not.toContain('App connected')
    fixture.gw.event(update(3, [figma('initiated')]))
    expect(call.connect?.targets[0]?.state).toBe('initiated')
    fixture.gw.event(update(4, [figma('connected')]))
    expect(call.connect?.targets[0]?.state).toBe('connected')
    expect(view(call)).toContain('App connected')
    expect(fixture.gw.sent('connection.respond')).toEqual([])
    expect(fixture.gw.sent('prompt.submit')).toEqual([])
  })

  it('gateway supersession changes only the older matching target, never the new operation', async () => {
    const slack = figma('initiated', { name: 'slack', connect_url: 'https://portal/connect/slack' })
    const { app, call: older } = await fixture.waitingOnFigma([figma('initiated'), slack])
    fixture.gw.event(update(3, [figma('superseded'), slack]))
    expect(older.connect?.targets.map(t => [t.name, t.state])).toEqual([['figma', 'superseded'], ['slack', 'initiated']])
    expect(view(older)).toContain('asked again below')
    expect(view(older)).toContain('connect-open=op1:slack')
    expect(view(older)).not.toContain('connect-open=op1:figma')
    fixture.gw.event(toolStart('call_new'))
    fixture.gw.event(request('op-new', 'call_new'))
    await flush()
    const newer = must(app.transcript.call(toolCallId('call_new')))
    expect(newer.connect).toMatchObject({ op: { id: 'op-new' }, settled: undefined, targets: [{ state: 'initiated' }] })
    fixture.gw.event(update(4, [figma('superseded'), { ...slack, state: 'not_connected' }], {
      settled: true, settled_at: Date.now() / 1000, settled_by: 'continue'
    }))
    const before = view(newer)
    await fixture.click('connect-continue', 'op1')
    await fixture.click('connect-skip', 'op1:figma')
    await fixture.click('connect-open', 'op1:figma')
    fixture.gw.event(update(99, [figma('connected')]))
    expect(older.connect).toMatchObject({ settled: 'continued', targets: [{ state: 'superseded' }, { state: 'not_connected' }] })
    expect(view(older)).not.toContain('connect-')
    expect(view(newer)).toBe(before)
    expect(fixture.gw.sent('connection.respond')).toEqual([])
    expect(fixture.gw.sent('connectors.operation.wake')).toEqual([])
    expect(browsed).toEqual([])
    await fixture.click('connect-open', 'op-new:figma')
    expect(fixture.gw.sent('connectors.operation.wake')).toEqual([{ op_id: 'op-new', owner: OWNER }])
    expect(fixture.gw.sent('prompt.submit')).toEqual([])
  })

  it('only a gateway deadline-settled frame removes actions and explains the expired wait', async () => {
    const { app, call } = await fixture.waitingOnFigma()
    const deadline = must(call.connect?.op).deadlineAt
    fixture.gw.handlers.set('connectors.operation.status', () => ({ ...update(2, [figma('initiated')]).payload, deadline_at: deadline }))
    vi.spyOn(Date, 'now').mockReturnValue((deadline + 1) * 1000)
    app.stores.connect.watch()
    await flush()
    expect(call.connect?.settled).toBeUndefined()
    expect(view(call)).toContain('connect-open=op1:figma')
    expect(view(call)).toContain('connect-continue=op1')
    fixture.gw.event(update(3, [figma('not_connected', { connect_url: null })], {
      deadline_at: deadline, settled: true, settled_at: Date.now() / 1000, settled_by: 'deadline'
    }))
    expect(call.connect).toMatchObject({ settled: 'deadline', targets: [{ state: 'not_connected', url: FIGMA }] })
    expect(view(call)).toContain('Hermes stopped waiting. Ask it to connect again.')
    expect(view(call)).toContain('not connected')
    expect(view(call)).not.toContain('connect-')
    expect(fixture.gw.sent('connection.respond')).toEqual([])
    expect(fixture.gw.sent('prompt.submit')).toEqual([])
  })

  it('Continue settles pending targets from the gateway update and removes every action', async () => {
    const slack = figma('initiated', { name: 'slack', connect_url: 'https://portal/connect/slack' })
    const { call } = await fixture.waitingOnFigma([figma('initiated'), slack])
    fixture.gw.handlers.set('connection.respond', () => ({ status: 'ok', settled: true }))
    await fixture.click('connect-continue', 'op1')
    expect(fixture.gw.sent('connection.respond')).toEqual([{ op_id: 'op1', owner: OWNER, result: { settled_by: 'continue' } }])
    fixture.gw.event(update(3, [figma('not_connected', { connect_url: null }), { ...slack, state: 'not_connected', connect_url: null }], {
      settled: true, settled_at: Date.now() / 1000, settled_by: 'continue'
    }))
    expect(call.connect).toMatchObject({ settled: 'continued', targets: [
      { state: 'not_connected', url: FIGMA }, { state: 'not_connected', url: 'https://portal/connect/slack' }
    ] })
    expect(view(call)).toContain('not connected')
    expect(view(call)).not.toContain('connect-')
    await fixture.click('connect-continue', 'op1')
    expect(fixture.gw.sent('connection.respond')).toHaveLength(1)
    expect(fixture.gw.sent('prompt.submit')).toEqual([])
  })
})
