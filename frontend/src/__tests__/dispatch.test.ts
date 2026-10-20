// The gateway dispatcher (gateway/dispatch.ts): what each event did to the pane ('render' or
// 'quiet', as the switch it replaced did with `break` and `return`), the tap's note of an unknown
// event type, the handler tables, and the order a finished tool call or message tells the stores in.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AnyGatewayEvent } from '@tui/gatewayTypes.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { toolCallId } from '../core/ids.js'
import { IGNORED } from '../gateway/coverage.js'
import { HANDLERS, type Outcome } from '../gateway/dispatch.js'
import { agentHandlers } from '../gateway/handlers/agents.js'
import { chromeHandlers } from '../gateway/handlers/chrome.js'
import { processHandlers } from '../gateway/handlers/processes.js'
import { promptHandlers } from '../gateway/handlers/prompts.js'
import { sessionHandlers } from '../gateway/handlers/session.js'
import { turnHandlers } from '../gateway/handlers/turn.js'
import type { ToolCall } from '../model.js'
import { afterMessageComplete, afterToolComplete, type MessageFanout, type ToolFanout } from '../turn/fanout.js'
import { record } from '../wire/json.js'

import { FakeGateway, fakeTern, settle } from './fakes.js'
import { replay, replays } from './replays.js'

/** Each event the app dispatched, with what it did to the pane. */
const seen = vi.hoisted((): [string, string][] => [])

vi.mock('../gateway/dispatch.js', async importOriginal => {
  const real = await importOriginal<typeof import('../gateway/dispatch.js')>()

  return {
    ...real,
    dispatcher: (...args: Parameters<typeof real.dispatcher>) => {
      const dispatch = real.dispatcher(...args)

      return (ev: AnyGatewayEvent): Outcome => {
        const outcome = dispatch(ev)
        seen.push([ev.type, outcome])

        return outcome
      }
    }
  }
})
vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))
vi.mock('../hermes/sessionIndex.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../hermes/sessionIndex.js')>()),
  lastReply: () => '',
  storedSessions: () => []
}))

const home = mkdtempSync(join(tmpdir(), 'hermes-tern-dispatch-'))
process.env['HERMES_HOME'] = home

const { App } = await import('../app/chat.js')

beforeEach(() => {
  seen.length = 0
  vi.spyOn(Math, 'random').mockReturnValue(0)
  // The title's OSC goes to stdout.
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.useFakeTimers({ now: new Date('2026-01-02T03:04:05Z'), toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** What the switch the dispatcher replaced did with each fixture's events, in order. */
const TODAY: Record<string, [string, Outcome][]> = {
  'turn-tools': [
    ['gateway.ready', 'render'],
    ['message.start', 'render'],
    ['message.delta', 'render'],
    ['tool.generating', 'render'],
    ['tool.start', 'render'],
    ['tool.complete', 'render'],
    ['tool.start', 'render'],
    ['tool.complete', 'render'],
    ['message.delta', 'render'],
    ['message.complete', 'render'],
    ['session.info', 'render']
  ],
  'queue-steer': [
    ['gateway.ready', 'render'],
    ['message.start', 'render'],
    ['message.delta', 'render'],
    ['session.info', 'render'],
    // The completion prompt.cancel sends for the withdrawn queued row.
    ['message.complete', 'quiet'],
    ['session.info', 'render'],
    ['session.info', 'render'],
    ['message.complete', 'render'],
    ['message.start', 'render'],
    ['session.info', 'render'],
    ['message.complete', 'render']
  ],
  'compress-resume': [
    ['gateway.ready', 'render'],
    ['message.start', 'render'],
    ['status.update', 'render'],
    ['status.update', 'render'],
    ['message.delta', 'render'],
    ['message.complete', 'render'],
    ['session.info', 'render']
  ],
  'approval-clarify': [
    ['gateway.ready', 'render'],
    ['message.start', 'render'],
    ['tool.start', 'render'],
    ['approval.request', 'render'],
    ['approval.settled', 'render'],
    ['tool.complete', 'render'],
    ['clarify.request', 'render'],
    ['clarify.settled', 'render'],
    ['message.complete', 'render']
  ]
}

/** Events past the fixtures, each with what the replaced switch did with it once session s1 is shown. */
const EVENTS: [Record<string, unknown>, Outcome][] = [
  [{ payload: { control: {} }, session_id: 's1', type: 'session.control.update' }, 'quiet'],
  [{ payload: {}, type: 'sessions.changed' }, 'quiet'],
  [{ payload: { chunk: 'x', process_id: 'p1' }, session_id: 's1', type: 'agent.terminal.output' }, 'quiet'],
  [{ payload: {}, session_id: 's1', type: 'agent.terminal.output' }, 'quiet'],
  [{ payload: { text: '  ' }, session_id: 's1', type: 'review.summary' }, 'quiet'],
  [{ payload: { text: 'saved a skill' }, session_id: 's1', type: 'review.summary' }, 'render'],
  [{ payload: { preview: 'junk' }, type: 'gateway.protocol_error' }, 'render'],
  // Reported once: the second has no note.
  [{ payload: { preview: 'more' }, type: 'gateway.protocol_error' }, 'quiet'],
  [{ payload: {}, session_id: 's1', type: 'made.up' }, 'quiet'],
  [{ payload: { line: 'x' }, type: 'gateway.stderr' }, 'quiet'],
  // Another session's traffic.
  [{ payload: { text: 'nope' }, session_id: 'other', type: 'message.delta' }, 'quiet'],
  [{ payload: { message: 'hi' }, session_id: 's1', type: 'notice' }, 'render'],
  [{ payload: { message: 'bad' }, session_id: 's1', type: 'error' }, 'render'],
  [{ payload: {}, type: 'skin.changed' }, 'render'],
  [{ payload: { key: 'k', text: 'credits low' }, session_id: 's1', type: 'notification.show' }, 'render'],
  [{ payload: { key: 'k' }, session_id: 's1', type: 'notification.clear' }, 'render'],
  [{ payload: { task_id: 't1', text: 'done' }, session_id: 's1', type: 'background.complete' }, 'render'],
  [{ payload: { question: 'q', text: 'a' }, session_id: 's1', type: 'btw.complete' }, 'render'],
  [{ payload: { stderr_tail: '' }, type: 'gateway.start_timeout' }, 'render'],
  [{ payload: { attempt: 2, delay_ms: 10 }, type: 'gateway.reconnecting' }, 'render'],
  [{ payload: { title: 'T' }, session_id: 's1', type: 'session.title' }, 'render'],
  [{ payload: { total_tokens: 3 }, session_id: 's1', type: 'session.usage' }, 'render'],
  [{ payload: { todos: [] }, session_id: 's1', type: 'todo.updated' }, 'render'],
  [{ payload: { id: 'r9' }, session_id: 's1', type: 'request.cancel' }, 'render'],
  [{ payload: { request_ids: ['x'] }, session_id: 's1', type: 'approval.cancelled' }, 'render'],
  [{ payload: { goal: 'g', task_index: 0 }, session_id: 's1', type: 'subagent.start' }, 'render'],
  [{ payload: { status: 'completed', task_index: 0 }, session_id: 's1', type: 'subagent.complete' }, 'render'],
  [{ payload: { label: 'a', text: 'b' }, session_id: 's1', type: 'moa.reference' }, 'render'],
  [{ payload: {}, session_id: 's1', type: 'moa.phase' }, 'render'],
  [{ payload: { text: 'pondering...' }, session_id: 's1', type: 'thinking.delta' }, 'render'],
  [{ payload: { text: 'r' }, session_id: 's1', type: 'reasoning.available' }, 'render'],
  [{ payload: { text: 'i' }, session_id: 's1', type: 'message.interim' }, 'render'],
  [{ payload: {}, session_id: 's1', type: 'session.replay_gap' }, 'quiet']
]

/** An App on the fakes with session s1 shown. */
async function started() {
  const gw = new FakeGateway({
    replies: {
      'session.create': () => ({ info: { stored_session_id: 's1' }, session_id: 's1' }),
      'setup.status': () => ({ provider_configured: true })
    }
  })
  const app = new App(fakeTern({ cols: 100 }).session, gw.client, '1.0.0')
  void app.run()
  await settle(gw)
  gw.event({ payload: {}, type: 'gateway.ready' })
  await settle(gw)
  seen.length = 0

  return { app, gw }
}

describe('what each event does to the pane', () => {
  for (const [name, r] of Object.entries(replays)) {
    it(`as before, in the ${r.fixture} replay (${name})`, async () => {
      await replay(r)

      expect(seen).toEqual(TODAY[r.fixture])
    })
  }

  it('as before, for the events past the fixtures: the quiet ones ask for no render', async () => {
    const { app, gw } = await started()

    for (const [ev] of EVENTS) {
      gw.event(ev)
      await settle(gw)
    }

    expect(seen).toEqual(EVENTS.map(([ev, outcome]) => [ev['type'], outcome]))
    app.quit()
  })

  it('tells the tap of an undeclared event type once; an ignored one is not told', async () => {
    const log = join(home, 'unknown.jsonl')
    process.env['HERMES_TERN_EVENT_LOG'] = log

    try {
      const { app, gw } = await started()

      for (const type of ['made.up', 'gateway.stderr', 'made.up']) {
        gw.event({ payload: {}, type })
        await settle(gw)
      }

      app.quit()
    } finally {
      delete process.env['HERMES_TERN_EVENT_LOG']
    }

    const lines = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => record(line))

    expect(lines.filter(line => line && 'unknown' in line)).toEqual([{ unknown: 'made.up' }])
    expect(lines.filter(line => line?.['type'] === 'made.up')).toHaveLength(2)
  })
})

describe('the handler tables', () => {
  it('name each event type once, and none of the ignored ones', () => {
    const tables = [agentHandlers, chromeHandlers, processHandlers, promptHandlers, sessionHandlers, turnHandlers]
    const names = tables.flatMap(table => Object.keys(table))
    const ignored: readonly string[] = IGNORED

    expect(new Set(names).size).toBe(names.length)
    expect(Object.keys(HANDLERS).sort()).toEqual([...names].sort())
    expect(names.filter(name => ignored.includes(name))).toEqual([])
  })
})

/** A call the fakes hand back. */
const CALL: ToolCall = {
  args: {},
  argsText: '',
  context: '',
  id: toolCallId('c1'),
  name: 'terminal',
  startedAt: 0,
  status: 'done'
}

describe('afterToolComplete', () => {
  /** The order the stores were told in, for a finished call of tool `name`. */
  function told(name: string): string[] {
    const log: string[] = []
    const note = (what: string) => () => void log.push(what)
    const cx: ToolFanout = {
      agents: { scan: note('agents.scan') },
      connect: { watch: note('connect.watch') },
      processes: { poke: note('processes.poke') },
      prs: { onCall: note('prs.onCall'), relink: note('prs.relink') },
      showImage: note('media'),
      sidebar: { poke: note('sidebar.poke') },
      transcript: { call: () => CALL, calls: () => [CALL] }
    }

    afterToolComplete({ name, tool_id: 'c1' }, cx)

    return log
  }

  it('tells the image, the agents, the PRs, the sidebar, the connect cards and the processes, in that order', () => {
    expect(told('read_file')).toEqual(['media', 'agents.scan'])
    expect(told('delegate_task')).toEqual(['media', 'agents.scan', 'prs.relink'])
    expect(told('link_pull_request')).toEqual(['media', 'agents.scan', 'prs.onCall'])
    expect(told('patch')).toEqual(['media', 'agents.scan', 'sidebar.poke'])
    expect(told('manage_connections')).toEqual(['media', 'agents.scan', 'connect.watch'])
    expect(told('terminal')).toEqual(['media', 'agents.scan', 'sidebar.poke', 'processes.poke'])
  })
})

describe('afterMessageComplete', () => {
  it('folds the message, ends the turn and any compaction, drains, then reads the PRs and the sidebar again', () => {
    const log: string[] = []
    const note = (what: string) => () => void log.push(what)
    const cx: MessageFanout = {
      activity: { endBusy: note('endBusy'), endCompaction: note('endCompaction') },
      drain: note('drain'),
      prs: { poke: note('prs.poke') },
      sidebar: { poke: note('sidebar.poke') },
      summarize: note('summarize'),
      transcript: { complete: note('complete'), uncompact: running => void log.push(`uncompact ${String(running)}`) }
    }

    afterMessageComplete({}, cx)

    expect(log).toEqual(['complete', 'endBusy', 'endCompaction', 'uncompact true', 'summarize', 'drain', 'prs.poke', 'sidebar.poke'])
  })
})
