// The session lifecycle's parts on their own: the tickets awaited work checks (Epoch, the shown
// session's, a slash reply's), the order of an adopt's steps, and the order a switch settles in.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Usage } from '@hermes/shared/gateway-events'
import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import type { SessionInfo } from '@tui/types.js'
import { describe, expect, it } from 'vitest'

import { Epoch } from '../core/epoch.js'
import { liveSessionId, NO_SESSION, type SessionIds, storedSessionId } from '../core/ids.js'
import { adoptAll, type AdoptHost, adoptSteps, type Snapshot } from '../session/adopt.js'
import { SessionLifecycle } from '../session/lifecycle.js'
import { SessionState } from '../session/state.js'
import { Transcript } from '../transcript/store.js'
import type { BusyMode } from '../turn/serverQueue.js'

import { FakeGateway, settle } from './fakes.js'

process.env['HERMES_HOME'] = mkdtempSync(join(tmpdir(), 'hermes-tern-session-'))

const a = liveSessionId('a')
const b = liveSessionId('b')

describe('Epoch', () => {
  it('makes every earlier ticket stale on next(), and aborts its signal', () => {
    const epoch = new Epoch()
    const first = epoch.current()

    expect(epoch.generation).toBe(0)
    expect(first.isCurrent()).toBe(true)
    expect(first.signal.aborted).toBe(false)

    const second = epoch.next()

    expect(epoch.generation).toBe(1)
    expect(first.isCurrent()).toBe(false)
    expect(first.signal.aborted).toBe(true)
    expect(second.isCurrent()).toBe(true)
    expect(second.signal.aborted).toBe(false)
    // A ticket taken now is the same generation's.
    expect(epoch.current().isCurrent()).toBe(true)

    epoch.next()
    expect(second.isCurrent()).toBe(false)
    expect(second.signal.aborted).toBe(true)
  })
})

describe('SessionState', () => {
  it('asks for a render on every write', () => {
    let renders = 0
    const state = new SessionState(() => renders++)

    state.ref = { live: a, stored: null }
    state.info = { model: 'm' }
    state.usage = { total: 1 }
    state.busyMode = 'steer'

    expect(renders).toBe(4)
    expect([state.ref.live, state.info?.model, state.usage?.total, state.busyMode]).toEqual([a, 'm', 1, 'steer'])
  })

  it('keeps a ticket current while its session is shown, as the guards it replaced did', () => {
    const state = new SessionState(() => undefined)
    state.ref = { live: a, stored: storedSessionId('sa') }
    const ticket = state.ticket()

    expect(ticket.sid).toBe(a)
    // The stored id moving leaves the runtime id, so the ticket holds.
    state.ref = { live: a, stored: storedSessionId('other') }
    expect(ticket.isCurrent()).toBe(true)
    expect(ticket.signal.aborted).toBe(false)

    state.ref = { live: b, stored: null }
    expect(ticket.isCurrent()).toBe(false)
    expect(ticket.signal.aborted).toBe(true)

    // A reattach that keeps the runtime id: current again (as `sid === this.sid` was), the signal stays aborted.
    state.ref = { live: a, stored: null }
    expect(ticket.isCurrent()).toBe(true)
    expect(ticket.signal.aborted).toBe(true)
  })

  it('gives a sessionless ticket that goes stale once a session is shown', () => {
    const state = new SessionState(() => undefined)
    const ticket = state.ticket()

    expect(ticket.sid).toBeNull()
    expect(ticket.isCurrent()).toBe(true)

    state.ref = { live: a, stored: null }
    expect(ticket.isCurrent()).toBe(false)
  })
})

/** The shown session's state, logging each write by its field. */
class RecordingState extends SessionState {
  readonly #log: string[]

  constructor(log: string[]) {
    super(() => undefined)
    this.#log = log
  }

  override get ref(): SessionIds {
    return super.ref
  }

  override set ref(ref: SessionIds) {
    this.#log.push(`ref ${ref.live}`)
    super.ref = ref
  }

  override get info(): SessionInfo | null {
    return super.info
  }

  override set info(info: SessionInfo | null) {
    this.#log.push('info')
    super.info = info
  }

  override get usage(): Usage | null {
    return super.usage
  }

  override set usage(usage: Usage | null) {
    this.#log.push('usage')
    super.usage = usage
  }

  override get busyMode(): BusyMode {
    return super.busyMode
  }

  override set busyMode(mode: BusyMode) {
    this.#log.push(`busyMode ${mode}`)
    super.busyMode = mode
  }
}

/** An adopt host on a recording fake: each call it gets is one line of `log`. */
function recordingHost() {
  const log: string[] = []
  const rec = (name: string) => () => void log.push(name)
  const transcript = new Transcript()
  const host: AdoptHost = {
    activity: { busy: null, endCompaction: rec('activity.endCompaction'), set: rec('activity.set') },
    agents: { adopt: sid => void log.push(`agents.adopt ${sid}`), scan: rec('agents.scan') },
    automation: { adopt: sid => void log.push(`automation.adopt ${sid}`) },
    changed: rec('changed'),
    connect: { watch: rec('connect.watch') },
    forgetStatusNote: rec('forgetStatusNote'),
    imageLanded: rec('imageLanded'),
    markPane: id => void log.push(`markPane ${id}`),
    markViewer: (now, before) => void log.push(`markViewer ${now} ${before}`),
    media: { showAll: rec('media.showAll') },
    notices: { reset: rec('notices.reset') },
    processes: { poke: rec('processes.poke') },
    prs: { adopt: rec('prs.adopt') },
    queue: { adopt: ref => void log.push(`queue.adopt ${ref.live}`), server: { reset: rec('queue.reset') } },
    readBusyMode: rec('readBusyMode'),
    reportCwd: rec('reportCwd'),
    sheets: { dropAll: rec('sheets.dropAll') },
    sidebar: { adopt: sid => void log.push(`sidebar.adopt ${sid}`) },
    showThoughts: sid => void log.push(`showThoughts ${sid}`),
    state: new RecordingState(log),
    title: { adopt: title => void log.push(`title.adopt ${title}`) },
    transcript: {
      get entries() {
        return transcript.entries
      },
      inflight: rec('transcript.inflight'),
      load: rec('transcript.load'),
      reset: ({ session }) => void log.push(`transcript.reset ${session}`)
    },
    writeActiveSession: id => void log.push(`writeActiveSession ${id}`)
  }

  return { host, log }
}

describe('adoptSteps', () => {
  const resumed: Snapshot = {
    inflight: { assistant: 'half', user: 'go on' },
    info: { stored_session_id: 'sb', title: 'Plans', usage: { total: 5 } },
    messages: [{ role: 'user', text: 'hi' }],
    running: true,
    session_id: 'b'
  }

  it("runs an adopt's steps in today's order, the ids first", () => {
    const { host, log } = recordingHost()
    host.state.ref = { live: a, stored: storedSessionId('sa') }
    log.length = 0

    adoptAll(adoptSteps(host), { previous: host.state.ref, r: resumed, ref: { live: b, stored: storedSessionId('sb') } })

    expect(log).toEqual([
      'ref b',
      // Another session: the transcript starts over at once, and the last one's sheets and busy-input mode go.
      'transcript.reset other',
      'sheets.dropAll',
      'busyMode queue',
      'readBusyMode',
      'queue.reset',
      'showThoughts b',
      'markViewer sb sa',
      'writeActiveSession sb',
      'markPane sb',
      'info',
      'usage',
      'title.adopt Plans',
      'reportCwd',
      'activity.set',
      'notices.reset',
      'activity.endCompaction',
      'forgetStatusNote',
      'agents.adopt b',
      // The history.
      'transcript.load',
      'agents.scan',
      'media.showAll',
      // Held prompts for another session go back after the history, so their notice stays.
      'queue.adopt b',
      'processes.poke',
      'connect.watch',
      'prs.adopt',
      'sidebar.adopt b',
      'automation.adopt b',
      'transcript.inflight',
      'changed'
    ])
  })

  it('keeps the per-session state on a reattach of the shown session, and skips what the snapshot lacks', () => {
    const { host, log } = recordingHost()
    host.state.ref = { live: a, stored: storedSessionId('sa') }
    log.length = 0

    adoptAll(adoptSteps(host), { previous: host.state.ref, r: { session_id: 'a' }, ref: { live: a, stored: storedSessionId('sa') } })

    expect(log).not.toContain('sheets.dropAll')
    expect(log).not.toContain('busyMode queue')
    expect(log).not.toContain('transcript.load')
    expect(log).not.toContain('transcript.inflight')
    expect(log.slice(0, 4)).toEqual(['ref a', 'transcript.reset same', 'readBusyMode', 'queue.reset'])
    expect(log.at(-1)).toBe('changed')
  })
})

/** A server request for session `sid`, logged when the lifecycle hands it on. */
function request(id: string, sid: string): ServerRequest {
  return { fail: () => undefined, id, method: 'approval.request', params: { session_id: sid }, respond: () => undefined }
}

/** A lifecycle on a fake shared gateway whose resumes answer when the test says. */
function lifecycle() {
  const gw = new FakeGateway()
  const log: string[] = []
  const answer = new Map<string, (r: Snapshot) => void>()
  gw.handlers.set('session.resume', p => new Promise(resolve => answer.set(String(p['session_id']), resolve)))
  gw.handlers.set('session.detach', p => void log.push(`detach ${String(p['session_id'])}`))
  const state = new SessionState(() => undefined)
  const life = new SessionLifecycle(
    {
      attachStartup: () => Promise.resolve(),
      awaitingStartup: () => false,
      canSwitch: () => ({ kind: 'switch' }),
      changed: () => void log.push('changed'),
      cols: () => 80,
      drain: () => void log.push('drain'),
      gw: gw.client,
      launch: { restored: false, resume: '', sessionCwd: '' },
      rename: () => Promise.resolve(),
      request: req => void log.push(`request ${req.id}`),
      sheets: { dropShared: () => undefined },
      state,
      transcript: new Transcript()
    },
    [
      {
        adopt: ({ ref }) => {
          state.ref = ref
        }
      }
    ]
  )
  const snapshot = (sid: string): Snapshot => ({ info: { stored_session_id: sid }, session_id: sid, subscription_id: `sub-${sid}` })

  /** Answers the resume of `sid` in flight. */
  const reply = (sid: string) => answer.get(sid)?.(snapshot(sid))

  return { gw, life, log, reply, state }
}

describe('SessionLifecycle', () => {
  it('settles a switch in order: stale results released, held requests replayed, the queue drained, a render', async () => {
    const t = lifecycle()
    const first = t.life.reload(storedSessionId('a'))
    await settle(t.gw)
    t.reply('a')
    await first
    expect(t.state.ref.live).toBe(a)

    const superseded = t.life.reload(storedSessionId('x'))
    const latest = t.life.reload(storedSessionId('y'))
    await settle(t.gw)
    t.reply('x')
    expect(await superseded).toBeUndefined()

    // Another session's request waits while the switch to y is in flight.
    expect(t.life.switching).toBe(true)
    expect(t.life.route(request('r1', 'z'))).toBe('hold')
    t.log.length = 0

    t.reply('y')
    await latest

    expect(t.log).toEqual(['detach x', 'request r1', 'drain', 'changed'])
    expect(t.life.switching).toBe(false)
    // Settled: another session's request drops now.
    expect(t.life.route(request('r2', 'z'))).toBe('drop')
  })

  it('drops a held request the gateway cancels, and every held one when the gateway goes', async () => {
    const t = lifecycle()
    const first = t.life.reload(storedSessionId('a'))
    await settle(t.gw)
    t.reply('a')
    await first

    void t.life.reload(storedSessionId('b'))
    t.life.route(request('r1', 'z'))
    t.life.route(request('r2', 'z'))

    expect(t.life.unhold('r1')).toBe(true)
    expect(t.life.unhold('r1')).toBe(false)

    t.life.lost()
    expect(t.state.ref).toEqual({ live: null, stored: storedSessionId('a') })
    expect(t.life.unhold('r2')).toBe(false)
  })

  it('makes a slash reply stale while a switch begun since is in flight, or once the view left the session', async () => {
    const t = lifecycle()
    const first = t.life.reload(storedSessionId('a'))
    await settle(t.gw)
    t.reply('a')
    await first

    const reply = t.life.replyTicket()
    expect(reply.sid).toBe(a)
    expect(reply.isCurrent()).toBe(true)

    // A reload of the same session: stale while it runs, current again once it adopted the same id.
    const again = t.life.reload(storedSessionId('a'))
    expect(reply.isCurrent()).toBe(false)
    await settle(t.gw)
    t.reply('a')
    await again
    expect(reply.isCurrent()).toBe(true)

    const away = t.life.reload(storedSessionId('b'))
    await settle(t.gw)
    t.reply('b')
    await away
    expect(reply.isCurrent()).toBe(false)
  })

  it('starts sessionless', () => {
    expect(lifecycle().state.ref).toEqual(NO_SESSION)
  })
})
