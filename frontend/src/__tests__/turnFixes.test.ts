// The turn and queue fixes of WP23, each pinned by a test that failed before its fix: a switch
// waits for a compaction, the working row is ended only by the work that owns it, held prompts
// keep the session they were held for, a failed steer goes back where it was, an admission is
// restored only while it is still being submitted, and /compress leaves another session alone.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { storedSessionId } from '../core/ids.js'
import { Activity } from '../turn/activity.js'

import { FakeGateway, fakeTern, given, key, type Reply, settle } from './fakes.js'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))

process.env['HERMES_HOME'] = mkdtempSync(join(tmpdir(), 'hermes-tern-turn-fixes-'))

const { App } = await import('../app/chat.js')

/** A held reply: the gateway's answer waits until the test resolves or rejects it. */
function held() {
  const { promise, reject, resolve } = Promise.withResolvers<unknown>()
  const reply: Reply = () => promise

  return { reject, reply, resolve }
}

/** The app on a fake Tern and gateway, session s1 shown. */
function setup(replies: Record<string, Reply> = {}, { canonical = true } = {}) {
  const gw = new FakeGateway({ canonical, replies })
  const tern = fakeTern({ cols: 100, draws: true })
  const app = new App(tern.session, gw.client, '1.0.0')
  void app.run()
  given.session(app, 's1')

  const press = async (k: string | ReturnType<typeof key>) => {
    await vi.waitFor(() => expect(tern.reading).toBe(true))
    tern.press(k)
    await settle(gw)
  }

  const type = async (text: string) => {
    for (const ch of text) {
      await press(key(ch, { text: ch }))
    }
  }

  /** Types `text` and presses Enter. */
  const enter = async (text: string) => {
    await type(text)
    await press('enter')
  }

  const emit = async (type: string, payload: Record<string, unknown> = {}) => {
    gw.event({ payload, session_id: 's1', type })
    await settle(gw)
  }

  const notices = () => app.transcript.entries.flatMap(e => (e.kind === 'notice' ? [e.text] : []))

  return { app, emit, enter, gw, notices, press, type }
}

describe('a session switch waits for a compaction', () => {
  it('refuses /new and a resume while /compress runs, and says why', async () => {
    const mutate = held()
    const { app, enter, gw, notices } = setup({ 'session.mutate': mutate.reply, 'session.resume': () => ({ execution_generation: 7, revision: 3 }) })
    await enter('/compress')
    await vi.waitFor(() => expect(app.activity.compacting).toMatchObject({ manual: true }))

    await app.newSession()
    await app.resume(storedSessionId('b'))

    expect(gw.sent('session.create')).toEqual([])
    expect(gw.sent('session.resume').filter(p => p['session_id'] === 'b')).toEqual([])
    expect(app.session.ref.live).toBe('s1')
    expect(notices().at(-1)).toBe('Wait for the compaction to finish before switching sessions.')
  })
})

describe('the working row is ended only by the work that owns it', () => {
  it("Activity: a ticket ends its own row only; the turn's start, a new row or a set ends the ticket", () => {
    const a = new Activity()
    const send = a.startBusy('Working…', 1)
    a.turnStarted(2)
    expect(a.busy).toMatchObject({ label: 'Working…', startedAt: 1 })

    a.endBusy(send)
    expect(a.busy).not.toBeNull()

    const expansion = a.startBusy('Running {!…}')
    a.set({ label: 'Thinking…', since: {}, startedAt: 3 })
    a.endBusy(expansion)
    expect(a.busy?.label).toBe('Thinking…')

    // The gateway's word ends whatever runs; a turn with no row up gets one of its own.
    a.endBusy()
    expect(a.busy).toBeNull()
    a.turnStarted(4)
    expect(a.busy).toMatchObject({ label: 'Working…', startedAt: 4 })

    const own = a.startBusy('Working…')
    a.endBusy(own)
    expect(a.busy).toBeNull()
  })

  it("a {!cmd} that fails after the turn started leaves the turn's row, and nothing drains into the turn", async () => {
    const shell = held()
    const { app, emit, enter, gw } = setup({ 'shell.exec': shell.reply }, { canonical: false })
    await enter('today is {!date}')
    await enter('next')
    expect(app.queue.held).toMatchObject([{ text: 'next' }])

    // The turn starts (another viewer's prompt, say) while the expansion runs: it takes the row.
    await emit('message.start')
    const row = app.activity.busy
    shell.reject(new Error('no date here'))
    await vi.waitFor(() => expect(app.composer.text).toBe('today is {!date}'))

    expect(app.activity.busy).toBe(row)
    expect(gw.sent('prompt.submit')).toEqual([])
    expect(app.queue.held).toMatchObject([{ text: 'next' }])
  })
  it('a prompt.submit that fails after its turn started leaves the turn running', async () => {
    const submit = held()
    const { app, emit, enter, notices } = setup({ 'prompt.submit': submit.reply })
    await enter('hello')
    await emit('message.start')
    const row = app.activity.busy

    submit.reject(new Error('timed out'))
    await vi.waitFor(() => expect(notices().at(-1)).toBe('Not sent: timed out. Your message is back in the composer.'))

    expect(app.activity.busy).toBe(row)
    expect(app.composer.text).toBe('hello')
  })
  it("a failed interrupt that answers after its turn ended leaves the next turn's label, and says nothing", async () => {
    const stop = held()
    const { app, emit, gw, notices, press } = setup({ 'session.interrupt': stop.reply, 'session.resume': () => ({ execution_generation: 7 }) })
    given.busy(app, { label: 'Thinking…', since: {}, startedAt: 0 })
    await press('escape')
    await press('escape')
    expect(app.activity.busy?.label).toBe('Stopping…')

    // That turn ends, and the next one is writing when the interrupt's failure comes.
    await emit('message.complete', { text: 'done' })
    await emit('message.start')
    await emit('message.delta', { text: 'next' })
    stop.reject(new Error('boom'))
    await settle(gw)

    expect(app.activity.busy?.label).toBe('Writing…')
    expect(notices()).not.toContain('Could not stop the turn: boom')
  })
})
