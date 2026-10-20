import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GatewayClient } from '@tui/gatewayClient.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseLiveLog } from '../agents/liveLog.js'
import { applyListRow, completionOutcomes, dispatchRows, endedStatus, mergeTail, OUTCOME_UNKNOWN } from '../agents/rows.js'
import { Agents, readLogFile } from '../agents/store.js'
import { liveSessionId } from '../core/ids.js'
import type { Subagent } from '../model.js'
import { Transcript } from '../transcript/store.js'

import { FakeGateway, must, stub } from './fakes.js'

// A finished child's log as tools/delegation_live_log.py writes it (lab run, 2026-10-17).
const DONE = `=== Hermes subagent live transcript ===
delegation: deleg_0074627c   task: 0
goal: Survey the repository layout
started: 2026-10-17 12:50:35
(append-only; streams while the subagent runs — tail -f me)
========================================
12:50:35 user     | kickoff: Survey the repository layout
12:50:35 start    | Survey the repository layout
12:50:35 tool     | -> terminal(sleep 3 + 1 command)
12:50:38 result   | terminal ok 3.2s: {"output": "lab", "exit_code": 0, "error": null}
12:50:38 tool     | -> terminal(sleep 4 + 2 commands)
12:50:43 result   | terminal ERROR 4.2s: boom
12:50:44 think    | Wrapping up.
12:50:44 assistant| Finished the delegated task.
12:50:44 final    | status=completed duration=8.87s summary: Finished the delegated task.
12:50:44 final    | end status=completed exit_reason=completed
`

describe('parseLiveLog', () => {
  it('pairs each tool line with its result and reads the outcome', () => {
    const log = parseLiveLog(DONE)

    expect(log.entries.map(e => e.kind)).toEqual(['kickoff', 'tool', 'tool', 'think', 'assistant'])
    expect(log.entries[1]).toMatchObject({ args: 'sleep 3 + 1 command', name: 'terminal', status: 'ok', took: 3200 })
    expect(log.entries[2]).toMatchObject({ result: 'boom', status: 'error', took: 4200 })
    expect(log).toMatchObject({ duration: 8.87, exitReason: 'completed', status: 'completed', summary: 'Finished the delegated task.' })
  })

  it('reads a tail that starts mid-line and leaves the last call running', () => {
    const log = parseLiveLog('ut | kickoff: cut\n12:00:01 tool     | -> read_file(a.md)\n')

    expect(log.entries).toEqual([{ args: 'a.md', at: '12:00:01', kind: 'tool', name: 'read_file', status: 'running' }])
    expect(log.status).toBeUndefined()
  })
})

describe('mergeTail', () => {
  const line = (n: number) => `12:00:${String(n).padStart(2, '0')} think    | step ${n}\n`
  const log = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => line(from + i)).join('')

  it('appends what a later tail adds past the overlap', () => {
    expect(mergeTail(log(1, 5), `ep 3\n${log(4, 8)}`)).toBe(log(1, 8))
  })

  it('keeps a gap when the log outgrew a tail, dropping the cut first line', () => {
    expect(mergeTail(log(1, 2), `ep 6\n${log(7, 8)}`)).toBe(log(1, 2) + log(7, 8))
  })
})

describe('subagent rows', () => {
  it('keeps a placeholder row and its node key when the owner names the child', () => {
    const list: Subagent[] = []
    dispatchRows(list, { delegationId: 'deleg_1', goals: ['Read the docs'], ids: [], paths: [] }, 0)
    const [row] = list

    expect(row).toMatchObject({ id: 'task-0', key: 'p0' })
    applyListRow(must(row), { delegation_id: 'deleg_1', depth: 0, subagent_id: 'sa-0-abcd' })
    expect(list).toEqual([row])
    expect(row).toMatchObject({ id: 'sa-0-abcd', key: 'p0', status: 'running' })
  })

  it('reads every reported end through one status parser', () => {
    expect(['completed', 'success', 'unknown', 'interrupted', 'cancelled', 'failed', 'error', 'timeout', '?'].map(endedStatus)).toEqual([
      'done',
      'done',
      'done',
      'cancelled',
      'cancelled',
      'failed',
      'failed',
      'failed',
      undefined
    ])
  })
})

describe('completionOutcomes', () => {
  it("reads each task's status from a batch completion", () => {
    const text = [
      '[ASYNC DELEGATION BATCH COMPLETE — deleg_1]',
      'A background fan-out unit you dispatched earlier — 2 subagent(s) — has finished.',
      '',
      '--- ✓ TASK 1/2: goal 0  (status=completed, api_calls=3, 4.1s) ---',
      'Did it.',
      '',
      '--- ✗ TASK 2/2: goal 1  (status=timeout, 600s) ---',
      '(no summary — status=timeout)'
    ].join('\n')

    expect(completionOutcomes(text)).toEqual({ delegationId: 'deleg_1', outcomes: new Map([[0, 'completed'], [1, 'timeout']]) })
  })

  it("reads a lone task's status, and a fan-out's early failure notice", () => {
    expect(completionOutcomes('[ASYNC DELEGATION COMPLETE — deleg_2]\nintro\n\nStatus: interrupted   API calls: 1')).toEqual({
      delegationId: 'deleg_2',
      outcomes: new Map([[0, 'interrupted']])
    })
    expect(completionOutcomes('[ASYNC DELEGATION TASK FAILED — deleg_3, task 2/3]\nwarn\nStatus: error   Duration: 3s')).toEqual({
      delegationId: 'deleg_3',
      outcomes: new Map([[1, 'error']])
    })
    expect(completionOutcomes('[IMPORTANT: Background process proc_1 finished (exit code 0)]')).toBeUndefined()
  })
})

describe('Agents', () => {
  let store: Agents | undefined

  afterEach(() => store?.dispose())

  /** A transcript holding one dispatched delegate_task call whose children log to `paths`. */
  function dispatched(paths: string[]) {
    const transcript = new Transcript()
    transcript.messageStart(0)
    transcript.toolStart(stub({ name: 'delegate_task', tool_id: 'c1' }), 0)
    transcript.toolComplete(
      stub({
        name: 'delegate_task',
        result: {
          delegation_id: 'deleg_1',
          goals: paths.map((_, i) => `goal ${i}`),
          live_transcripts: paths,
          mode: 'background',
          status: 'dispatched',
          subagent_ids: paths.map((_, i) => `sa-${i}-abcd`)
        },
        tool_id: 'c1'
      }),
      0
    )

    return transcript
  }

  it('turns a dispatched call into rows that finish from their logs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hermes-tern-agents-'))
    const path = join(dir, 'task-0.log')
    await writeFile(path, DONE)
    const transcript = dispatched([path])
    const gw = stub<GatewayClient>({ request: async () => ({ subagents: [] }) })
    let changes = 0
    store = new Agents({ changed: () => changes++, gw, sid: liveSessionId('s1'), transcript })

    store.scan()
    const [agent] = store.all()

    expect(agent).toMatchObject({ delegationId: 'deleg_1', id: 'sa-0-abcd', logPath: path, status: 'queued' })

    await store.refresh(must(agent))

    expect(agent).toMatchObject({ duration: 8870, status: 'done', summary: 'Finished the delegated task.', toolCount: 2 })
    expect(store.running()).toEqual([])
    expect(changes).toBeGreaterThan(0)
  })

  it('counts a missing log against a child only while it runs, not while it is queued', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hermes-tern-agents-'))
    const path = join(dir, 'task-0.log')
    const transcript = dispatched([path])
    const gw = stub<GatewayClient>({ request: async () => ({ subagents: [] }) })
    store = new Agents({ changed: () => undefined, gw, sid: liveSessionId('s1'), transcript })
    store.scan()
    const agent = must(store.all()[0])

    // Behind the concurrency limit: no log yet, however many reads find none.
    for (let i = 0; i < 5; i++) {
      await store.refresh(agent)
    }

    await writeFile(path, DONE)
    await store.refresh(agent)
    expect(agent).toMatchObject({ logPath: path, status: 'done' })

    // A running child whose log never appears (written on another machine) is given up on.
    const other = join(dir, 'task-1.log')
    const ran = new Agents({ changed: () => undefined, gw, sid: liveSessionId('s1'), transcript: dispatched([other]) })
    ran.scan()
    const child = must(ran.all()[0])
    child.status = 'running'

    for (let i = 0; i < 3; i++) {
      await ran.refresh(child)
    }

    await writeFile(other, DONE)
    await ran.refresh(child)
    expect(child.status).toBe('running')
    ran.dispose()
  })

  it('finds a resumed session\'s running children, whose dispatch result the history dropped', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hermes-tern-home-'))
    const dir = join(home, 'cache', 'delegation', 'live', 'deleg_9')
    const path = join(dir, 'task-1.log')
    await mkdir(dir, { recursive: true })
    await writeFile(path, '12:00:01 tool     | -> read_file(a.md)\n')
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ tasks: [{ index: 0 }, { index: 1, log: path }] }))
    const before = process.env['HERMES_HOME']
    process.env['HERMES_HOME'] = home

    // The display projection: a delegate_task row with its args and no result.
    const transcript = new Transcript()
    transcript.load(stub([
      { role: 'user', text: 'survey it' },
      {
        args: { tasks: [{ goal: 'Read the docs' }, { goal: 'Survey the layout' }] },
        name: 'delegate_task',
        role: 'tool',
        tool_call_id: 'c1'
      }
    ]))
    const row = { delegation_id: 'deleg_9', depth: 0, goal: 'Survey the layout', status: 'running', subagent_id: 'sa-1-beef', tool_count: 2 }
    const request = vi.fn(async (method: string) => (method === 'subagent.list' ? { subagents: [row] } : {}))
    let changes = 0
    store = new Agents({ changed: () => changes++, gw: stub<GatewayClient>({ request }), sid: liveSessionId('s1'), transcript })

    try {
      store.scan()
      await vi.waitFor(() => expect(must(store).running()).toHaveLength(1))
    } finally {
      process.env['HERMES_HOME'] = before
    }

    const [agent] = store.running()

    expect(request).toHaveBeenCalledWith('subagent.list', { session_id: 's1' })
    expect(agent).toMatchObject({ delegationId: 'deleg_9', depth: 0, id: 'sa-1-beef', index: 1, logPath: path, status: 'running' })
    expect(must(transcript.delegations()[0]).subagents).toEqual([agent])
    await vi.waitFor(() => expect(must(agent).tool).toBe('read_file'))
    expect(changes).toBeGreaterThan(0)
  })

  it('folds background subagents into the delegating call after its turn ended', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.toolStart({ args: { tasks: [{ goal: 'a' }, { goal: 'b' }] }, name: 'delegate_task', tool_id: 'd1' }, 1)
    t.toolComplete(
      {
        name: 'delegate_task',
        result: { delegation_id: 'deleg_1', mode: 'background', status: 'dispatched' },
        tool_id: 'd1'
      },
      2
    )
    t.complete({ status: 'complete', text: 'Dispatched.' }, 3)
    t.user({ at: 4, text: 'next' })
    t.messageStart(5)

    const agents = new Agents({ changed: () => undefined, gw: new FakeGateway().client, sid: liveSessionId('s1'), transcript: t })
    const base = { delegation_id: 'deleg_1', task_count: 2 }
    agents.apply('subagent.start', { ...base, goal: 'b', subagent_id: 's1', task_index: 1 }, 6)
    agents.apply('subagent.start', { ...base, goal: 'a', subagent_id: 's0', task_index: 0 }, 6)
    agents.apply(
      'subagent.tool',
      { ...base, goal: 'a', subagent_id: 's0', task_index: 0, tool_name: 'terminal', tool_preview: 'ls' },
      7
    )
    agents.apply(
      'subagent.complete',
      { ...base, api_calls: 2, goal: 'a', status: 'completed', subagent_id: 's0', summary: 'Done', task_index: 0 },
      9
    )

    const [call, ...later] = t.delegations()
    expect(call?.subagents?.map(a => [a.id, a.status, a.calls])).toEqual([
      ['s0', 'done', 2],
      ['s1', 'running', 0]
    ])
    expect(later).toEqual([])
    // Each row is keyed by the id it was made under.
    expect(call?.subagents?.map(a => a.key)).toEqual(['s0', 's1'])
  })


  it('bumps the turn holding the call an event changed', () => {
    const t = new Transcript()
    const turn = t.messageStart(0)
    t.toolStart({ name: 'delegate_task', tool_id: 'd1' }, 1)
    const agents = new Agents({ changed: () => undefined, gw: new FakeGateway().client, sid: liveSessionId('s1'), transcript: t })
    const rev = turn.rev

    agents.apply('subagent.start', { goal: 'a', subagent_id: 's0', task_count: 1, task_index: 0 }, 2)

    expect(turn.rev).toBe(rev + 1)
    expect(agents.all().map(a => [a.id, a.status])).toEqual([['s0', 'running']])
  })

  it('does not probe a session with no delegate_task call', () => {
    const request = vi.fn(async () => ({ subagents: [] }))
    const transcript = new Transcript()
    transcript.load(stub([{ role: 'user', text: 'hi' }]))
    store = new Agents({ changed: () => undefined, gw: stub<GatewayClient>({ request }), sid: liveSessionId('s1'), transcript })

    store.scan()

    expect(request).not.toHaveBeenCalled()
  })

  it('pauses and resumes new spawns through delegation.pause, keeping the flag', async () => {
    const request = vi.fn(async (_method: string, params: { paused: boolean }) => ({ paused: params.paused }))
    let changes = 0
    store = new Agents({ changed: () => changes++, gw: stub<GatewayClient>({ request }), sid: liveSessionId('s1'), transcript: new Transcript() })

    expect(store.paused).toBeUndefined()
    expect(await store.pause(true)).toBe(true)
    expect(request).toHaveBeenCalledWith('delegation.pause', { paused: true, session_id: 's1' })
    expect(store.paused).toBe(true)
    expect(await store.pause(false)).toBe(false)
    expect(store.paused).toBe(false)
    expect(changes).toBe(2)
  })

  describe('across a session switch', () => {
    /** A resumed history with one result-less delegate_task call asking for `goal` (task 0). */
    function resumed(transcript: Transcript, goal: string) {
      transcript.load([
        { role: 'user', text: 'go' },
        { args: { tasks: [{ goal }] }, name: 'delegate_task', role: 'tool', tool_call_id: 'c1' }
      ])
    }

    /** A store whose `subagent.list` answers wait for the test (`answer`, oldest first), on a shown session the test switches. */
    function switching() {
      const answers: ((rows: object[]) => void)[] = []
      const gw = new FakeGateway({
        replies: { 'subagent.list': () => new Promise(resolve => answers.push(rows => resolve({ subagents: rows }))) }
      })
      const transcript = new Transcript()
      const shown = { sid: liveSessionId('a') }
      const agents = new Agents({
        changed: () => undefined,
        gw: gw.client,
        get sid() {
          return shown.sid
        },
        transcript
      })

      return { agents, answer: (rows: object[]) => must(answers.shift())(rows), lists: () => gw.sent('subagent.list'), shown, transcript }
    }

    it("drops a poll for session A that answers after the switch to B, so A's child stays off B's card", async () => {
      const { agents, answer, lists, shown, transcript } = switching()
      store = agents
      resumed(transcript, 'Read the docs')
      agents.adopt(shown.sid)
      agents.scan()
      await vi.waitFor(() => expect(lists()).toHaveLength(1))

      // Switch: B's history asks for the same goal.
      shown.sid = liveSessionId('b')
      agents.adopt(shown.sid)
      resumed(transcript, 'Read the docs')
      agents.scan()
      answer([{ delegation_id: 'deleg_a', depth: 0, goal: 'Read the docs', status: 'running', subagent_id: 'sa-0-aaaa' }])

      // B's own probe runs once A's poll is done with, and finds nothing.
      await vi.waitFor(() => expect(lists()).toEqual([{ session_id: 'a' }, { session_id: 'b' }]))
      answer([])
      await new Promise(resolve => setImmediate(resolve))

      expect(must(transcript.delegations()[0]).subagents).toBeUndefined()
      expect(agents.all()).toEqual([])
    })

    it("runs a resumed session's probe that arrives while a poll is in flight, after it", async () => {
      const { agents, answer, lists, shown, transcript } = switching()
      store = agents
      resumed(transcript, 'Old goal')
      agents.adopt(shown.sid)
      agents.scan()
      await vi.waitFor(() => expect(lists()).toHaveLength(1))

      shown.sid = liveSessionId('b')
      agents.adopt(shown.sid)
      resumed(transcript, 'Survey the layout')
      agents.scan()
      answer([])

      await vi.waitFor(() => expect(lists()).toEqual([{ session_id: 'a' }, { session_id: 'b' }]))
      answer([{ delegation_id: 'deleg_b', depth: 0, goal: 'Survey the layout', status: 'running', subagent_id: 'sa-0-bbbb' }])

      await vi.waitFor(() => expect(agents.running().map(a => a.id)).toEqual(['sa-0-bbbb']))
    })
  })

  describe('reading a log file', () => {
    it("reads a log that was not there yet once it is: a missing file is 'not yet'", async () => {
      const dir = await mkdtemp(join(tmpdir(), 'hermes-tern-agents-'))
      const path = join(dir, 'task-0.log')

      expect(await readLogFile(path, undefined)).toEqual({ kind: 'notYet' })

      const agents = new Agents({ changed: () => undefined, gw: new FakeGateway().client, sid: liveSessionId('s1'), transcript: dispatched([path]) })
      store = agents
      agents.scan()
      const agent = must(agents.all()[0])

      await agents.refresh(agent)
      expect(agent.log).toBeUndefined()

      await writeFile(path, DONE)
      await agents.refresh(agent)
      expect(agent).toMatchObject({ status: 'done', summary: 'Finished the delegated task.' })
    })

    it('tells a log this process may not read apart from one that is not there, and one that did not grow', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'hermes-tern-agents-'))
      const path = join(dir, 'task-0.log')
      await writeFile(path, DONE)

      expect(await readLogFile(path, undefined)).toMatchObject({ kind: 'ok', size: Buffer.byteLength(DONE) })
      expect(await readLogFile(path, Buffer.byteLength(DONE))).toEqual({ kind: 'same' })

      await chmod(path, 0)

      try {
        // Root reads it anyway; any other user may not.
        if (process.getuid?.() !== 0) {
          expect(await readLogFile(path, undefined)).toMatchObject({ error: expect.objectContaining({ code: 'EACCES' }), kind: 'unreadable' })
        }
      } finally {
        await chmod(path, 0o644)
      }
    })
  })

  describe('with no log this process can read (a remote gateway)', () => {
    afterEach(() => vi.useRealTimers())

    /** A dispatched call of `n` background tasks whose logs are not on this machine. */
    function remote(n: number) {
      const transcript = new Transcript()
      transcript.messageStart(0)
      transcript.toolStart(stub({ name: 'delegate_task', tool_id: 'c1' }), 0)
      transcript.toolComplete(
        stub({
          name: 'delegate_task',
          result: {
            delegation_id: 'deleg_1',
            goals: Array.from({ length: n }, (_, i) => `goal ${i}`),
            mode: 'background',
            status: 'dispatched',
            subagent_ids: Array.from({ length: n }, (_, i) => `sa-${i}-abcd`)
          },
          tool_id: 'c1'
        }),
        0
      )

      return transcript
    }

    it('ends a child the list never showed after a grace, then takes its outcome from the completion', async () => {
      vi.useFakeTimers()
      const request = vi.fn(async () => ({ subagents: [] }))
      const agentEnded = vi.fn()
      store = new Agents({ agentEnded, changed: () => undefined, gw: stub<GatewayClient>({ request }), sid: liveSessionId('s1'), transcript: remote(2) })

      store.scan()
      await vi.advanceTimersByTimeAsync(1000)
      expect(store.running()).toHaveLength(2)

      await vi.advanceTimersByTimeAsync(2000)
      expect(store.running()).toEqual([])
      expect(store.all().map(a => [a.status, a.exitReason])).toEqual([
        ['done', OUTCOME_UNKNOWN],
        ['done', OUTCOME_UNKNOWN]
      ])

      // Each end is told once (the pane re-reads the PRs a subagent linked).
      expect(agentEnded).toHaveBeenCalledTimes(2)

      // Nothing runs, so polling stopped.
      const polls = request.mock.calls.length
      await vi.advanceTimersByTimeAsync(5000)
      expect(request.mock.calls.length).toBe(polls)

      store.settle(
        '[ASYNC DELEGATION BATCH COMPLETE — deleg_1]\n\n--- ✓ TASK 1/2: goal 0  (status=completed) ---\n\n--- ✗ TASK 2/2: goal 1  (status=failed) ---'
      )
      expect(store.all().map(a => [a.status, a.exitReason])).toEqual([
        ['done', undefined],
        ['failed', undefined]
      ])
      expect(agentEnded).toHaveBeenCalledTimes(2)
    })

    it('does not call a child that left the list Done, and merges its log tails', async () => {
      vi.useFakeTimers()
      let listed = true
      const tails = ['12:00:01 tool     | -> read_file(a.md)\n', 'md)\n12:00:01 tool     | -> read_file(a.md)\n12:00:02 think    | next\n']
      const request = vi.fn(async (method: string) =>
        method === 'subagent.list'
          ? { subagents: listed ? [{ delegation_id: 'deleg_1', depth: 0, status: 'running', subagent_id: 'sa-0-abcd' }] : [] }
          : { available: true, text: tails.shift() ?? '', truncated: true }
      )
      store = new Agents({ changed: () => undefined, gw: stub<GatewayClient>({ request }), sid: liveSessionId('s1'), transcript: remote(1) })

      store.scan()
      await vi.advanceTimersByTimeAsync(1000)
      const [agent] = store.all()
      expect(must(agent).status).toBe('running')
      expect(must(agent).log?.entries.map(e => e.kind)).toEqual(['tool', 'think'])

      listed = false
      await vi.advanceTimersByTimeAsync(1000)
      expect(agent).toMatchObject({ exitReason: OUTCOME_UNKNOWN, status: 'done' })

      store.settle('[ASYNC DELEGATION COMPLETE — deleg_1]\nintro\n\nStatus: interrupted   API calls: 2')
      expect(agent).toMatchObject({ exitReason: undefined, status: 'cancelled' })
    })
  })
})
