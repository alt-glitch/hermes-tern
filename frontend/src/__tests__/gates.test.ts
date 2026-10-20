// The router's gates and the working line's busy state: canSend, canDrain and canSwitch over
// every combination of the state they read, the labels' last-write-wins order, and a send's
// {!cmd} expansion counting as a turn everywhere busy is read.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { liveSessionId } from '../core/ids.js'
import { Activity } from '../turn/activity.js'
import { canDrain, canSend, canSwitch, type GateState } from '../turn/router.js'

import { FakeGateway, fakeTern, given, key, type Reply, settle } from './fakes.js'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))

process.env['HERMES_HOME'] = mkdtempSync(join(tmpdir(), 'hermes-tern-gates-'))

const { App } = await import('../app/chat.js')

const S1 = liveSessionId('s1')

/** The flags a gate state is made of; `sid` stands for a session (s1) against none. */
const FLAGS = ['sid', 'switching', 'busy', 'compacting', 'awaitingStartup', 'canonical'] as const

type Flag = (typeof FLAGS)[number]

/** The state with each flag in `on` set. */
function state(on: ReadonlySet<Flag>): GateState {
  return {
    awaitingStartup: on.has('awaitingStartup'),
    busy: on.has('busy'),
    canonical: on.has('canonical'),
    compacting: on.has('compacting'),
    sid: on.has('sid') ? S1 : null,
    switching: on.has('switching')
  }
}

/** Every combination of the flags: 64 states, each with the set of flags it has on. */
const COMBINATIONS: ReadonlySet<Flag>[] = Array.from({ length: 2 ** FLAGS.length }, (_, n) => new Set(FLAGS.filter((_, i) => n & (2 ** i))))

const name = (on: ReadonlySet<Flag>) => [...on].join('+') || 'nothing'

/** Each gate, its answer as a comparable value, and the flags it reads (the others never change it). */
const GATES: { name: string; answer: (s: GateState) => unknown; reads: readonly Flag[] }[] = [
  { answer: s => canSend(s).kind, name: 'canSend', reads: ['sid', 'switching', 'busy', 'compacting'] },
  { answer: canDrain, name: 'canDrain', reads: ['sid', 'switching', 'busy', 'compacting', 'awaitingStartup'] },
  { answer: s => canSwitch(s).kind, name: 'canSwitch', reads: ['busy', 'compacting'] }
]

describe('the gates, for every combination of session, switch, turn, compaction, startup image and gateway', () => {
  it('canSend: no session or a switch holds; then a turn takes the busy path, a compaction queues behind, else send', () => {
    for (const on of COMBINATIONS) {
      const want = !on.has('sid') || on.has('switching') ? { kind: 'hold' } : { kind: on.has('busy') ? 'busy' : on.has('compacting') ? 'behind' : 'send', sid: S1 }
      expect(canSend(state(on)), name(on)).toEqual(want)
    }
  })

  it('canDrain: only an adopted, idle session with no startup image waiting drains', () => {
    for (const on of COMBINATIONS) {
      const drains = on.has('sid') && !on.has('switching') && !on.has('busy') && !on.has('compacting') && !on.has('awaitingStartup')
      expect(canDrain(state(on)), name(on)).toBe(drains)
    }
  })

  it('canSwitch: a turn or a compaction makes the switch wait, each with its own notice', () => {
    for (const on of COMBINATIONS) {
      const want = on.has('busy')
        ? { kind: 'wait', notice: 'Wait for the current turn to finish (or press Esc twice) before switching sessions.' }
        : on.has('compacting')
          ? { kind: 'wait', notice: 'Wait for the compaction to finish before switching sessions.' }
          : { kind: 'switch' }
      expect(canSwitch(state(on)), name(on)).toEqual(want)
    }
  })

  it('each gate reads its own flags: flipping another never changes its answer, and each one it reads can', () => {
    for (const { answer, name: gate, reads } of GATES) {
      for (const flag of FLAGS) {
        const flips = COMBINATIONS.some(on => {
          const other = new Set(on)

          if (other.has(flag)) {
            other.delete(flag)
          } else {
            other.add(flag)
          }

          return answer(state(on)) !== answer(state(other))
        })

        expect(flips, `${gate} reads ${flag}`).toBe(reads.includes(flag))
      }
    }
  })
})

describe('Activity: replace-only writes, last-write-wins labels', () => {
  it('a relabel replaces the busy object and keeps its age', () => {
    const a = new Activity()
    a.startBusy('Working…', 1000)
    const first = a.busy
    a.relabel('Thinking…')

    expect(a.busy).not.toBe(first)
    expect(first?.label).toBe('Working…')
    expect(a.busy).toEqual({ label: 'Thinking…', since: first?.since, startedAt: 1000 })
  })

  it("'Stopping…' lasts until the stream's next label", () => {
    const a = new Activity()
    a.startBusy('Thinking…')
    a.relabel('Stopping…', { status: true })
    expect(a.busy?.label).toBe('Stopping…')

    a.relabel('Writing…')
    expect(a.busy?.label).toBe('Writing…')
  })

  it("the stream's labels wait while the context is compacted; a status line's show", () => {
    const a = new Activity()
    a.startBusy('Working…')
    a.startCompaction({ manual: false })
    a.relabel('Writing…')
    expect(a.busy?.label).toBe('Working…')

    a.relabel('Compacting context…', { status: true })
    expect(a.busy?.label).toBe('Compacting context…')

    a.endCompaction()
    a.relabel('Writing…')
    expect(a.busy?.label).toBe('Writing…')
  })

  it('an empty label, or no turn, changes nothing', () => {
    const a = new Activity()
    a.relabel('Writing…', { status: true })
    expect(a.busy).toBeNull()

    a.startBusy('Working…')
    const before = a.busy
    a.relabel('')
    expect(a.busy).toBe(before)
  })

  it('a compaction already running keeps its age and kind when another start edge comes', () => {
    const a = new Activity()
    a.startCompaction({ manual: true }, 5)
    const first = a.compacting
    a.startCompaction({ manual: false }, 9)

    expect(a.compacting).toBe(first)
    expect(a.compaction).toMatchObject({ kind: 'running', manual: true, startedAt: 5 })

    a.endCompaction()
    expect(a.compaction).toEqual({ kind: 'none' })
    expect(a.compacting).toBeUndefined()
  })
})

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

  const emit = async (type: string, payload: Record<string, unknown> = {}) => {
    gw.event({ payload, session_id: 's1', type })
    await settle(gw)
  }

  return { app, emit, gw, press, type }
}

describe('App: the working line', () => {
  it("Esc Esc writes 'Stopping…', and the stream's next label replaces it", async () => {
    const stop = held()
    const { app, emit, press } = setup({ 'session.interrupt': stop.reply, 'session.resume': () => ({ execution_generation: 7 }) })
    const { since } = given.busy(app, { label: 'Thinking…', since: {}, startedAt: 0 })

    await press('escape')
    await press('escape')
    expect(app.activity.busy).toEqual({ label: 'Stopping…', since, startedAt: 0 })

    await emit('message.delta', { text: 'still going' })
    expect(app.activity.busy).toEqual({ label: 'Writing…', since, startedAt: 0 })
  })

  it("a failed interrupt writes 'Working…' over whatever label came meanwhile", async () => {
    const stop = held()
    const { app, emit, press } = setup({ 'session.interrupt': stop.reply, 'session.resume': () => ({ execution_generation: 7 }) })
    given.busy(app, { label: 'Thinking…', since: {}, startedAt: 0 })

    await press(key('c', { ctrl: true }))
    await emit('message.delta', { text: 'more' })
    expect(app.activity.busy?.label).toBe('Writing…')

    stop.reject(new Error('boom'))
    await vi.waitFor(() => expect(app.activity.busy?.label).toBe('Working…'))
    expect(app.transcript.entries.at(-1)).toMatchObject({ kind: 'notice', text: 'Could not stop the turn: boom' })
  })
})

describe("App: a send's {!cmd} expansion counts as a turn", () => {
  it("shows 'Running {!…}', and the turn's start, the labels, the drain, a switch and the commands all see it as busy", async () => {
    const shell = held()
    const { app, emit, gw, press, type } = setup({ 'shell.exec': shell.reply }, { canonical: false })
    await type('today is {!date}')
    await press('enter')

    expect(app.activity.busy?.label).toBe('Running {!…}')
    expect(app.control().busy).toBe(true)

    // The drain waits: a prompt behind it is held (a private gateway's queue), not sent.
    await type('next')
    await press('enter')
    expect(app.queue.held).toMatchObject([{ text: 'next' }])
    expect(gw.sent('prompt.submit')).toEqual([])

    // A session switch is refused.
    await app.newSession()
    expect(gw.sent('session.create')).toEqual([])
    expect(app.transcript.entries.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('Wait for the current turn to finish') })

    // message.start finds a turn running and keeps its row; the stream's labels relabel it.
    const { since } = app.activity.busy ?? { since: undefined }
    await emit('message.start')
    expect(app.activity.busy).toMatchObject({ label: 'Running {!…}', since })
    await emit('message.delta', { text: 'hi' })
    expect(app.activity.busy).toMatchObject({ label: 'Writing…', since })

    // Expanded after the turn started: the prompt waits behind the turn, ahead of the one held
    // meanwhile, and the turn keeps its row.
    shell.resolve({ code: 0, stderr: '', stdout: 'Monday\n' })
    await vi.waitFor(() => expect(app.queue.held).toMatchObject([{ text: 'today is Monday' }, { text: 'next' }]))
    expect(gw.sent('prompt.submit')).toEqual([])
    expect(app.activity.busy).toMatchObject({ label: 'Writing…', since })
  })
})
