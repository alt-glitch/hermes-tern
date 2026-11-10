import type { GatewayClient } from '@hermes/shared/gateway-client'
import { JsonRpcGatewayError } from '@hermes/shared/json-rpc-channel'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { applyListRow, completionOutcomes, dispatchRows, endedStatus, OUTCOME_UNKNOWN } from '../agents/rows.js'
import { Agents } from '../agents/store.js'
import { agentSteps } from '../agents/transcript.js'
import { liveSessionId } from '../core/ids.js'
import type { Subagent } from '../model.js'
import { Transcript } from '../transcript/store.js'

import { FakeGateway, must, stub } from './fakes.js'

describe('subagent rows', () => {
  it('keeps a placeholder row and its node key when the owner names the child', () => {
    const list: Subagent[] = []
    dispatchRows(list, { delegationId: 'deleg_1', goals: ['Read the docs'], ids: [] }, 0)
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

  afterEach(() => {
    store?.dispose()
    vi.useRealTimers()
  })

  /** A transcript holding one dispatched delegate_task call of `n` children. */
  function dispatched(n: number) {
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

  /** A child's stored rows as `session.transcript` serves them. */
  const ROWS = [
    { role: 'user', row_kind: 'message', text: 'goal 0', timestamp: 100 },
    { reasoning: 'Look first.', role: 'assistant', row_kind: 'message', text: '', timestamp: 101 },
    { context: 'sleep 3 + 1 command', name: 'terminal', role: 'tool', row_kind: 'message', timestamp: 104.5 },
    { role: 'assistant', row_kind: 'message', text: 'Finished.', timestamp: 105 }
  ]

  it("reads the followed agent's stored transcript into its timeline, then stops once it ended and is caught up", async () => {
    vi.useFakeTimers()
    const pages = [
      { available: true, next_cursor: 'c1', reset: true, rows: ROWS.slice(0, 2), running: true },
      { available: true, next_cursor: 'c1', reset: false, rows: [], running: true },
      { available: true, next_cursor: 'c2', reset: false, rows: ROWS.slice(2), running: false },
      { available: true, next_cursor: 'c2', reset: false, rows: [], running: false }
    ]
    const gw = new FakeGateway({ replies: { 'session.transcript': () => pages.shift() } })
    store = new Agents({ changed: () => undefined, gw: gw.client, sid: liveSessionId('s1'), transcript: dispatched(1) })
    // An event-fed row: the store polls nothing but the followed transcript.
    store.apply('subagent.start', { goal: 'goal 0', subagent_id: 'sa-0-abcd', task_count: 1, task_index: 0 })
    store.scan()
    const agent = must(store.all()[0])

    store.follow(agent)
    await vi.advanceTimersByTimeAsync(0)
    expect(agent.steps).toHaveLength(2)
    expect(gw.sent('session.transcript')).toEqual([
      { limit: 200, order: 'oldest', session_id: 's1', subagent_id: 'sa-0-abcd' },
      { cursor: 'c1', limit: 200, order: 'oldest', session_id: 's1', subagent_id: 'sa-0-abcd' }
    ])

    await vi.advanceTimersByTimeAsync(1000)
    expect(agentSteps(agent)).toEqual([
      { at: 100_000, kind: 'kickoff', text: 'goal 0' },
      { at: 101_000, kind: 'think', text: 'Look first.' },
      { args: 'sleep 3 + 1 command', at: 104_500, kind: 'tool', name: 'terminal', running: false },
      { at: 105_000, kind: 'assistant', text: 'Finished.' }
    ])

    // Ended and caught up: no more reads.
    await vi.advanceTimersByTimeAsync(5000)
    expect(gw.sent('session.transcript')).toHaveLength(4)
  })

  it('reads progress for the four visible wait tiles without opening the hub', async () => {
    vi.useFakeTimers()
    const gw = new FakeGateway({ replies: {
      'session.transcript': () => ({ available: true, next_cursor: null, reset: true, rows: ROWS, running: true })
    } })
    store = new Agents({ changed: () => undefined, gw: gw.client, sid: liveSessionId('s1'), transcript: dispatched(5) })
    store.scan()

    await vi.advanceTimersByTimeAsync(0)

    expect(gw.sent('session.transcript').map(p => p['subagent_id'])).toEqual([
      'sa-0-abcd', 'sa-1-abcd', 'sa-2-abcd', 'sa-3-abcd'
    ])
    expect(store.all().slice(0, 4).every(a => a.steps?.some(s => s.kind === 'assistant' && s.text === 'Finished.'))).toBe(true)
    expect(store.all()[4]?.steps).toBeUndefined()
  })

  it('replaces the rows it holds on a reset, and shows the tool a running agent has not stored yet', async () => {
    vi.useFakeTimers()
    const pages = [
      { available: true, next_cursor: 'c1', reset: true, rows: ROWS, running: true },
      { available: true, next_cursor: 'c1', reset: false, rows: [], running: true },
      { available: true, next_cursor: 'c9', reset: true, rows: ROWS.slice(0, 1), running: true }
    ]
    const gw = new FakeGateway({ replies: { 'session.transcript': () => pages.shift() ?? { available: true, next_cursor: 'c9', reset: false, rows: [], running: true } } })
    store = new Agents({ changed: () => undefined, gw: gw.client, sid: liveSessionId('s1'), transcript: dispatched(1) })
    store.apply('subagent.tool', { goal: 'goal 0', subagent_id: 'sa-0-abcd', task_count: 1, task_index: 0, tool_count: 2, tool_name: 'read_file', tool_preview: 'a.md' })
    store.scan()
    const agent = must(store.all()[0])

    store.follow(agent)
    await vi.advanceTimersByTimeAsync(0)
    expect(agent.steps).toHaveLength(4)
    expect(agentSteps(agent).at(-1)).toMatchObject({ args: 'a.md', kind: 'tool', name: 'read_file', running: true })

    await vi.advanceTimersByTimeAsync(1000)
    expect(agent.steps).toHaveLength(1)
  })

  it("publishes a parent the gateway does not hold live with one plain read, then reads the child", async () => {
    let live = false
    const gw = new FakeGateway({
      replies: {
        'session.transcript': params => {
          if (!params['subagent_id']) {
            live = true

            return { next_cursor: null, reset: true, rows: [] }
          }

          if (!live) {
            throw new JsonRpcGatewayError('not_found', { code: 4001, data: { reason: 'not_found' } })
          }

          return { available: true, next_cursor: 'c1', reset: true, rows: [], running: false }
        }
      }
    })
    store = new Agents({ changed: () => undefined, gw: gw.client, sid: liveSessionId('s1'), transcript: dispatched(1) })
    store.scan()
    store.follow(must(store.all()[0]))

    await vi.waitFor(() => expect(gw.sent('session.transcript')).toHaveLength(3))
    expect(gw.sent('session.transcript').map(p => p['subagent_id'] ?? null)).toEqual(['sa-0-abcd', null, 'sa-0-abcd'])
  })

  it('finds a resumed session\'s running children, whose dispatch result the history dropped', async () => {
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
    const row = { delegation_id: 'deleg_9', depth: 0, goal: 'Survey the layout', last_tool: 'read_file', status: 'running', subagent_id: 'sa-1-beef', tool_count: 2 }
    const request = vi.fn(async (method: string) => (method === 'subagent.list' ? { subagents: [row] } : {}))
    let changes = 0
    store = new Agents({ changed: () => changes++, gw: stub<GatewayClient>({ request }), sid: liveSessionId('s1'), transcript })

    store.scan()
    await vi.waitFor(() => expect(must(store).running()).toHaveLength(1))

    const [agent] = store.running()

    expect(request).toHaveBeenCalledWith('subagent.list', { session_id: 's1' })
    expect(agent).toMatchObject({ delegationId: 'deleg_9', depth: 0, id: 'sa-1-beef', index: 1, status: 'running', tool: 'read_file', toolCount: 2 })
    expect(must(transcript.delegations()[0]).subagents).toEqual([agent])
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

  describe('rows no event reached', () => {
    afterEach(() => vi.useRealTimers())

    /** A dispatched call of `n` background tasks. */
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

    it('does not call a child that left the list Done: the completion says how it ended', async () => {
      vi.useFakeTimers()
      let listed = true
      const request = vi.fn(async () => ({
        subagents: listed ? [{ delegation_id: 'deleg_1', depth: 0, last_tool: 'read_file', status: 'running', subagent_id: 'sa-0-abcd' }] : []
      }))
      store = new Agents({ changed: () => undefined, gw: stub<GatewayClient>({ request }), sid: liveSessionId('s1'), transcript: remote(1) })

      store.scan()
      await vi.advanceTimersByTimeAsync(1000)
      const [agent] = store.all()
      expect(agent).toMatchObject({ status: 'running', tool: 'read_file' })

      listed = false
      await vi.advanceTimersByTimeAsync(1000)
      expect(agent).toMatchObject({ exitReason: OUTCOME_UNKNOWN, status: 'done' })

      store.settle('[ASYNC DELEGATION COMPLETE — deleg_1]\nintro\n\nStatus: interrupted   API calls: 2')
      expect(agent).toMatchObject({ exitReason: undefined, status: 'cancelled' })
    })
  })
})
