// The run status Tern shows on the pane and notifies about (OSC 7501): what each turn, question
// and quit reports, through the app on the fake gateway, and how a report body is written.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import { ProgramStatus, reportBody, runStatus, type StatusSources } from '../session/programStatus.js'

import { FakeGateway, fakeTern, given, settle } from './fakes.js'

vi.mock('@hermes/shared/prompt-history', () => ({ append: () => undefined, load: () => [] }))

process.env['HERMES_HOME'] = mkdtempSync(join(tmpdir(), 'hermes-tern-program-status-'))

const { App } = await import('../app/chat.js')

const b64 = (s: string) => Buffer.from(s).toString('base64')

let write: MockInstance

beforeEach(() => {
  write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(() => {
  write.mockRestore()
})

/** The OSC 7501 bodies written so far, oldest first. */
function reports(): string[] {
  return write.mock.calls.flatMap(c => {
    const m = /^\x1b\]7501;(.*)\x1b\\$/.exec(String(c[0])) // eslint-disable-line no-control-regex -- the OSC 7501 frame is what this reads

    return m?.[1] ? [m[1]] : []
  })
}

/** The app on a fake Tern and gateway, session s1 shown. */
function setup() {
  const gw = new FakeGateway()
  const tern = fakeTern({ cols: 100, draws: true })
  const app = new App(tern.session, gw.client, '1.0.0')
  const done = app.run()
  given.session(app, 's1')

  const emit = async (type: string, payload: Record<string, unknown> = {}) => {
    gw.event({ payload, session_id: 's1', type })
    await settle(gw)
  }

  /** A server request for s1, as the gateway sends one. */
  const ask = async (id: string, method: string, params: Record<string, unknown>) => {
    gw.emit('request', { fail: vi.fn(), id, method, params: { ...params, session_id: 's1' }, respond: vi.fn() })
    await settle(gw)
  }

  return { app, ask, done, emit, gw }
}

describe('the run status Tern shows for the pane', () => {
  it('reports working while a turn runs and done when it ends', async () => {
    const { emit } = setup()
    await emit('message.start')
    await emit('message.delta', { text: 'hi' })
    await emit('message.complete', { status: 'complete', text: 'hi' })

    expect(reports()).toEqual(['state=idle:app=hermes', 'state=working:app=hermes', 'state=done:app=hermes'])
  })

  it('reports blocked on an approval, with its command, and working again once it is answered', async () => {
    const { ask, emit } = setup()
    await emit('message.start')
    await ask('r1', 'approval', { command: 'rm -rf build' })
    await emit('request.cancel', { id: 'r1' })

    expect(reports().slice(1)).toEqual([
      'state=working:app=hermes',
      `state=blocked:kind=permission:app=hermes:msg=${b64('Approve: rm -rf build')}`,
      'state=working:app=hermes'
    ])
  })

  it('reports a clarify question as blocked on a question, and a sudo prompt as blocked on auth', async () => {
    const { ask, emit } = setup()
    await emit('message.start')
    await ask('r1', 'clarify', { questions: [{ choices: ['a', 'b'], qid: 'q1', question: 'Which branch?' }] })
    await emit('request.cancel', { id: 'r1' })
    await ask('r2', 'sudo', { command: 'apt install x' })

    expect(reports()).toContain(`state=blocked:kind=question:app=hermes:msg=${b64('Which branch?')}`)
    expect(reports().at(-1)).toBe(`state=blocked:kind=auth:app=hermes:msg=${b64('Password for sudo')}`)
  })

  it('reports a failed turn as error with its message, and an interrupted one as idle', async () => {
    const { emit } = setup()
    await emit('message.start')
    await emit('message.complete', { error: 'HTTP 429: rate limited', status: 'error' })
    expect(reports().at(-1)).toBe(`state=error:app=hermes:msg=${b64('rate limited')}`)

    await emit('message.start')
    await emit('message.complete', { status: 'interrupted' })
    expect(reports().at(-1)).toBe('state=idle:app=hermes')
  })

  it('writes a report only when the status changes', async () => {
    const { emit } = setup()
    await emit('message.start')

    for (const text of ['a', 'b', 'c']) {
      await emit('message.delta', { text })
    }

    expect(reports()).toEqual(['state=idle:app=hermes', 'state=working:app=hermes'])
  })

  it('takes the record away when the pane quits', async () => {
    const { app, done, emit } = setup()
    await emit('message.start')
    await emit('message.complete', { status: 'complete', text: 'ok' })
    app.quit()
    await done

    expect(reports().at(-1)).toBe('state=clear')
  })
})

describe('runStatus', () => {
  const idle: StatusSources = { lastTurn: undefined, sid: 's1', waiting: undefined, working: false }

  it("counts a turn's end as done only when this pane saw it run: a resumed session's last turn is old news", () => {
    expect(runStatus({ ...idle, lastTurn: { status: 'done' } }, false)).toEqual({ state: 'idle' })
    expect(runStatus({ ...idle, lastTurn: { status: 'done' } }, true)).toEqual({ state: 'done' })
  })

  it('puts a waiting question ahead of the running turn', () => {
    expect(runStatus({ ...idle, waiting: { kind: 'question', msg: 'Which?' }, working: true }, true)).toEqual({ kind: 'question', msg: 'Which?', state: 'blocked' })
  })

  it("forgets the last session's run when another session is shown", () => {
    const bodies: string[] = []
    const status = new ProgramStatus(body => bodies.push(body))
    status.sync({ ...idle, working: true })
    status.sync({ ...idle, lastTurn: { status: 'done' }, sid: 's2' })

    expect(bodies).toEqual(['state=working:app=hermes', 'state=idle:app=hermes'])
  })
})

describe('reportBody', () => {
  it('sends the message as one printable line, base64', () => {
    expect(reportBody({ msg: 'line one\nline\x07 two', state: 'error' })).toBe(`state=error:app=hermes:msg=${b64('line one line two')}`)
  })

  it('keeps the decoded message within the 2048-byte limit', () => {
    const body = reportBody({ kind: 'question', msg: 'é'.repeat(5000), state: 'blocked' })
    const msg = body.split(':msg=')[1] ?? ''

    expect(Buffer.from(msg, 'base64').byteLength).toBeLessThanOrEqual(2048)
  })
})
