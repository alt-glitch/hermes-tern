// The turn and queue fixes of WP23, each pinned by a test that failed before its fix: a switch
// waits for a compaction, the working row is ended only by the work that owns it, held prompts
// keep the session they were held for, a failed steer goes back where it was, an admission is
// restored only while it is still being submitted, and /compress leaves another session alone.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { sessionHost } from '../commands/host.js'
import { type LiveSessionId, liveSessionId, storedSessionId } from '../core/ids.js'
import { sessionTicket } from '../session/state.js'
import { SESSION_COMMANDS, type SessionHost } from '../sessionCommands.js'
import { Transcript } from '../transcript.js'
import { Activity } from '../turn/activity.js'
import type { Prompt } from '../turn/prompt.js'
import { PromptQueue, type QueueHost } from '../turn/queue.js'

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

describe('held prompts keep the session they were held for', () => {
  const resumed = (session_id: string, stored: string) => () => ({ info: { stored_session_id: stored }, messages: [], session_id })

  it("on a private gateway, a prompt held behind session A's turn goes back to the composer when B is adopted; one for the next session goes to B", async () => {
    const { app, enter, gw, notices } = setup({ 'session.resume': resumed('b', 'sb') }, { canonical: false })
    given.busy(app, { label: 'Working…', since: {}, startedAt: 0 })
    await enter('for A')
    expect(app.queue.held).toMatchObject([{ text: 'for A' }])

    // The gateway goes away (the turn with it); a prompt typed now waits for whichever session comes.
    gw.emit('exit', null)
    await enter('for whoever')
    await app.resume(storedSessionId('sb'))
    await settle(gw)

    expect(app.session.ref.live).toBe('b')
    expect(gw.sent('prompt.submit')).toMatchObject([{ session_id: 'b', text: 'for whoever' }])
    expect(app.composer.text).toBe('for A')
    expect(notices()).toContain('A prompt queued for the last session is back in the composer.')
  })

  it('the notice that says so stays when the adopted session brings its history', async () => {
    const history = () => ({ info: { stored_session_id: 'sb' }, messages: [{ role: 'user', text: 'earlier' }], session_id: 'b' })
    const { app, enter, gw, notices } = setup({ 'session.resume': history }, { canonical: false })
    given.busy(app, { label: 'Working…', since: {}, startedAt: 0 })
    await enter('for A')

    gw.emit('exit', null)
    await app.resume(storedSessionId('sb'))
    await settle(gw)

    expect(app.composer.text).toBe('for A')
    expect(app.transcript.entries.flatMap(e => (e.kind === 'user' ? [e.text] : []))).toEqual(['earlier'])
    expect(notices()).toContain('A prompt queued for the last session is back in the composer.')
  })

  it('a reattach of the same stored session keeps the prompts held for it', async () => {
    const { app, enter, gw } = setup({ 'session.resume': resumed('s1b', 'st1') }, { canonical: false })
    app.session.ref = { live: app.session.ref.live, stored: storedSessionId('st1') }
    given.busy(app, { label: 'Working…', since: {}, startedAt: 0 })
    await enter('for A')

    gw.emit('exit', null)
    gw.event({ payload: {}, type: 'gateway.ready' })
    await settle(gw)

    expect(app.session.ref.live).toBe('s1b')
    expect(gw.sent('prompt.submit')).toMatchObject([{ session_id: 's1b', text: 'for A' }])
  })
})

/** A PromptQueue over a fake gateway whose steers answer when the test says, and a log of what it did. */
function queueSetup() {
  const steer = held()
  const gw = new FakeGateway({ replies: { 'session.resume': () => ({ execution_generation: 1 }), 'session.steer': steer.reply } })
  const log: string[] = []
  const state: { canDrain: boolean; sid: LiveSessionId | null } = { canDrain: false, sid: liveSessionId('s1') }
  const host: QueueHost = {
    busy: () => true,
    canDrain: () => state.canDrain,
    changed: () => undefined,
    expanded: (_sid, prompt) => Promise.resolve(prompt),
    gw: gw.client,
    restore: prompt => log.push(`restore ${prompt.text}`),
    send: prompt => log.push(`send ${prompt.text}`),
    ticket: () => sessionTicket(() => state.sid, new AbortController().signal),
    transcript: {
      notice: (text, tone) => log.push(`${tone ?? 'info'}: ${text}`),
      steer: text => log.push(`steer ${text}`)
    }
  }
  const queue = new PromptQueue(host)
  const typed = (text: string): Prompt => ({ images: [], kind: 'typed', pasted: [], text })

  for (const text of ['a', 'b', 'c']) {
    queue.hold(typed(text))
  }

  return { gw, log, queue, state, steer }
}

describe('a held prompt whose steer fails goes back where it was', () => {
  it('after the prompts that were ahead of it, though the drain took one meanwhile', async () => {
    const t = queueSetup()
    t.queue.steer(1)
    expect(t.queue.held.map(p => p.text)).toEqual(['a', 'c'])

    // The turn ends: the drain sends the oldest while the steer is out.
    t.state.canDrain = true
    t.queue.drain()
    t.state.canDrain = false
    t.steer.reject(new Error('boom'))
    await settle(t.gw)

    expect(t.log).toEqual(['send a', 'warning: Steer failed: boom. It stays queued.'])
    expect(t.queue.held.map(p => p.text)).toEqual(['b', 'c'])
  })

  it('to the composer once the view left the session, and nothing is written to the next one', async () => {
    const t = queueSetup()
    t.queue.steer(0)
    t.state.sid = liveSessionId('s2')
    t.steer.reject(new Error('gone'))
    await settle(t.gw)

    expect(t.queue.held.map(p => p.text)).toEqual(['b', 'c'])
    expect(t.log).toEqual(['restore a', 'warning: The steer did not land before the session changed. It is back in the composer.'])

    const u = queueSetup()
    u.queue.steer(0)
    u.state.sid = null
    u.steer.resolve({ status: 'queued' })
    await settle(u.gw)
    expect(u.log).toEqual([])
  })
})

describe("this pane's admissions into the shared gateway's queue", () => {
  it('a prompt.submit that fails after the FIFO started its admission does not put it back in the composer', async () => {
    const submit = held()
    const { app, emit, enter, gw, notices } = setup({ 'prompt.submit': submit.reply })
    given.busy(app, { label: 'Working…', since: {}, startedAt: 0 })
    await enter('next one')
    const [sent] = gw.sent('prompt.submit')
    expect(sent).toMatchObject({ queued: true, text: 'next one' })

    // The FIFO lists it and starts it: its bubble shows; then the submit's late timeout comes.
    const row = { admission_id: 'a1', input_id: sent?.['submission_id'], user: 'next one' }
    await emit('session.info', { pending_submissions: [{ ...row, status: 'queued' }] })
    await emit('message.complete', { text: 'first reply' })
    await emit('session.info', { pending_submissions: [{ ...row, status: 'started' }] })
    submit.reject(new Error('timed out'))
    await settle(gw)

    expect(app.transcript.entries.flatMap(e => (e.kind === 'user' ? [e.text] : []))).toEqual(['next one'])
    expect(app.composer.text).toBe('')
    expect(notices()).not.toContain('Not queued: timed out. Your message is back in the composer.')
  })

  it("a prompt.submit that fails after the FIFO listed its admission keeps it queued as this pane's, not in the composer", async () => {
    const submit = held()
    const { app, emit, enter, gw, notices } = setup({ 'prompt.submit': submit.reply })
    given.busy(app, { label: 'Working…', since: {}, startedAt: 0 })
    await enter('next one')
    const [sent] = gw.sent('prompt.submit')

    // The FIFO lists it before prompt.submit answers; then the submit times out. The gateway still holds it.
    const row = { admission_id: 'a1', input_id: sent?.['submission_id'], status: 'queued', user: 'next one' }
    await emit('session.info', { pending_submissions: [row] })
    submit.reject(new Error('timed out'))
    await settle(gw)

    expect(app.composer.text).toBe('')
    expect(notices()).not.toContain('Not queued: timed out. Your message is back in the composer.')
    expect(app.queue.server.queued()).toMatchObject([{ id: 'a1', kind: 'mine', text: 'next one' }])
  })

  it("a withdrawn row's cancelled completion that comes after the session.info dropping it still leaves the turn running", async () => {
    const { app, emit, enter, gw } = setup({
      'prompt.cancel': () => ({ status: 'terminal' }),
      'prompt.submit': () => ({ admission_id: 'a1', status: 'queued' })
    })
    given.busy(app, { label: 'Working…', since: {}, startedAt: 0 })
    await enter('never mind')
    const row = { admission_id: 'a1', input_id: gw.sent('prompt.submit')[0]?.['submission_id'], status: 'queued', user: 'never mind' }
    await emit('session.info', { pending_submissions: [row] })

    // Alt+Up withdraws it; the FIFO drops the row before its cancelled completion comes.
    app.queue.dequeue(0)
    await settle(gw)
    await emit('session.info', { pending_submissions: [] })
    await emit('message.complete', { admission_id: 'a1', outcome: 'cancelled' })

    expect(app.activity.busy).not.toBeNull()
    expect(app.composer.text).toBe('never mind')
  })
})

describe('/compress takes back only its own compaction, and only in its own session', () => {
  it('a /compress that fails after the view left its session leaves the new one alone, and says nothing there', async () => {
    let stale = false
    const compressing = vi.fn()
    const notice = vi.fn()
    const gw = new FakeGateway({
      replies: {
        'session.mutate': () => {
          stale = true

          throw new Error('boom')
        },
        'session.resume': () => ({ execution_generation: 7, revision: 3 })
      }
    })
    const host: SessionHost = {
      busy: false,
      canonical: true,
      compressing,
      enqueue: () => undefined,
      gw: gw.client,
      notice,
      open: () => Promise.resolve(true),
      panel: () => undefined,
      queued: 0,
      reload: () => Promise.resolve(),
      send: () => undefined,
      sid: liveSessionId('s1'),
      stale: () => stale,
      submit: () => undefined
    }

    await SESSION_COMMANDS.find(c => c.name === 'compress')?.run(host, '')

    expect(compressing.mock.calls).toEqual([['start']])
    expect(notice).not.toHaveBeenCalled()
  })

  it('uncompact(c) drops compaction c, not the one seen last', () => {
    const t = new Transcript()
    const mine = t.compacting({ at: 1, manual: true })
    t.compacted(2)
    const hermes = t.compacting({ at: 3, before: 10 })
    expect(hermes).not.toBe(mine)

    t.uncompact(mine)
    expect(t.entries.flatMap(e => (e.kind === 'compaction' ? [e.compaction] : []))).toEqual([hermes])

    // A compaction already dropped (or never seen here) changes nothing.
    t.uncompact(mine)
    expect(t.entries.filter(e => e.kind === 'compaction')).toHaveLength(1)
  })

  it("the session host's 'none' takes back the compaction its 'start' opened", () => {
    const t = new Transcript()
    const host = sessionHost({
      activity: new Activity(),
      changed: () => undefined,
      gw: new FakeGateway().client,
      life: { reload: () => Promise.resolve(undefined), resume: () => Promise.resolve() },
      queue: { count: () => 0 },
      router: { behind: () => undefined, send: () => undefined },
      setCompacting: () => undefined,
      state: { ref: { live: liveSessionId('s1'), stored: null }, ticket: () => sessionTicket(() => liveSessionId('s1'), new AbortController().signal), usage: null },
      submit: () => undefined,
      transcript: t
    })

    host.compressing('start')
    // Its own status edge ends it; Hermes starts another before /compress answers that nothing changed.
    t.compacted(2)
    const hermes = t.compacting({ at: 3, before: 10 })
    host.compressing('none')

    expect(t.entries.flatMap(e => (e.kind === 'compaction' ? [e.compaction] : []))).toEqual([hermes])
  })
})
