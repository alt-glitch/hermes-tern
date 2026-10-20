import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GatewayClient } from '@tui/gatewayClient.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseLiveLog } from '../agents/liveLog.js'
import { Agents, completionOutcomes, mergeTail, OUTCOME_UNKNOWN } from '../agents/store.js'
import { liveSessionId } from '../core/ids.js'
import { Transcript } from '../transcript.js'

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
    transcript.start(0)
    transcript.toolStart({ name: 'delegate_task', tool_id: 'c1' } as never, 0)
    transcript.toolComplete(
      {
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
      } as never,
      0
    )

    return transcript
  }

  it('turns a dispatched call into rows that finish from their logs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hermes-tern-agents-'))
    const path = join(dir, 'task-0.log')
    await writeFile(path, DONE)
    const transcript = dispatched([path])
    const gw = { request: async () => ({ subagents: [] }) } as unknown as GatewayClient
    let changes = 0
    store = new Agents({ changed: () => changes++, gw, sid: liveSessionId('s1'), transcript })

    store.scan()
    const [agent] = store.all()

    expect(agent).toMatchObject({ delegationId: 'deleg_1', id: 'sa-0-abcd', logPath: path, status: 'queued' })

    await store.refresh(agent!)

    expect(agent).toMatchObject({ duration: 8870, status: 'done', summary: 'Finished the delegated task.', toolCount: 2 })
    expect(store.running()).toEqual([])
    expect(changes).toBeGreaterThan(0)
  })

  it('finds a resumed session\'s running children, whose dispatch result the history dropped', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hermes-tern-home-'))
    const dir = join(home, 'cache', 'delegation', 'live', 'deleg_9')
    const path = join(dir, 'task-1.log')
    await mkdir(dir, { recursive: true })
    await writeFile(path, '12:00:01 tool     | -> read_file(a.md)\n')
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ tasks: [{ index: 0 }, { index: 1, log: path }] }))
    const before = process.env.HERMES_HOME
    process.env.HERMES_HOME = home

    // The display projection: a delegate_task row with its args and no result.
    const transcript = new Transcript()
    transcript.load([
      { role: 'user', text: 'survey it' },
      {
        args: { tasks: [{ goal: 'Read the docs' }, { goal: 'Survey the layout' }] },
        name: 'delegate_task',
        role: 'tool',
        tool_call_id: 'c1'
      }
    ] as never)
    const row = { delegation_id: 'deleg_9', depth: 0, goal: 'Survey the layout', status: 'running', subagent_id: 'sa-1-beef', tool_count: 2 }
    const request = vi.fn(async (method: string) => (method === 'subagent.list' ? { subagents: [row] } : {}))
    let changes = 0
    store = new Agents({ changed: () => changes++, gw: { request } as unknown as GatewayClient, sid: liveSessionId('s1'), transcript })

    try {
      store.scan()
      await vi.waitFor(() => expect(store!.running()).toHaveLength(1))
    } finally {
      process.env.HERMES_HOME = before
    }

    const [agent] = store.running()

    expect(request).toHaveBeenCalledWith('subagent.list', { session_id: 's1' })
    expect(agent).toMatchObject({ delegationId: 'deleg_9', depth: 0, id: 'sa-1-beef', index: 1, logPath: path, status: 'running' })
    expect(transcript.delegations()[0]!.subagents).toEqual([agent])
    await vi.waitFor(() => expect(agent!.tool).toBe('read_file'))
    expect(changes).toBeGreaterThan(0)
  })

  it('does not probe a session with no delegate_task call', () => {
    const request = vi.fn(async () => ({ subagents: [] }))
    const transcript = new Transcript()
    transcript.load([{ role: 'user', text: 'hi' }] as never)
    store = new Agents({ changed: () => undefined, gw: { request } as unknown as GatewayClient, sid: liveSessionId('s1'), transcript })

    store.scan()

    expect(request).not.toHaveBeenCalled()
  })

  it('pauses and resumes new spawns through delegation.pause, keeping the flag', async () => {
    const request = vi.fn(async (_method: string, params: { paused: boolean }) => ({ paused: params.paused }))
    let changes = 0
    store = new Agents({ changed: () => changes++, gw: { request } as unknown as GatewayClient, sid: liveSessionId('s1'), transcript: new Transcript() })

    expect(store.paused).toBeUndefined()
    expect(await store.pause(true)).toBe(true)
    expect(request).toHaveBeenCalledWith('delegation.pause', { paused: true, session_id: 's1' })
    expect(store.paused).toBe(true)
    expect(await store.pause(false)).toBe(false)
    expect(store.paused).toBe(false)
    expect(changes).toBe(2)
  })

  describe('with no log this process can read (a remote gateway)', () => {
    afterEach(() => vi.useRealTimers())

    /** A dispatched call of `n` background tasks whose logs are not on this machine. */
    function remote(n: number) {
      const transcript = new Transcript()
      transcript.start(0)
      transcript.toolStart({ name: 'delegate_task', tool_id: 'c1' } as never, 0)
      transcript.toolComplete(
        {
          name: 'delegate_task',
          result: {
            delegation_id: 'deleg_1',
            goals: Array.from({ length: n }, (_, i) => `goal ${i}`),
            mode: 'background',
            status: 'dispatched',
            subagent_ids: Array.from({ length: n }, (_, i) => `sa-${i}-abcd`)
          },
          tool_id: 'c1'
        } as never,
        0
      )

      return transcript
    }

    it('ends a child the list never showed after a grace, then takes its outcome from the completion', async () => {
      vi.useFakeTimers()
      const request = vi.fn(async () => ({ subagents: [] }))
      const agentEnded = vi.fn()
      store = new Agents({ agentEnded, changed: () => undefined, gw: { request } as unknown as GatewayClient, sid: liveSessionId('s1'), transcript: remote(2) })

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
      store = new Agents({ changed: () => undefined, gw: { request } as unknown as GatewayClient, sid: liveSessionId('s1'), transcript: remote(1) })

      store.scan()
      await vi.advanceTimersByTimeAsync(1000)
      const [agent] = store.all()
      expect(agent!.status).toBe('running')
      expect(agent!.log?.entries.map(e => e.kind)).toEqual(['tool', 'think'])

      listed = false
      await vi.advanceTimersByTimeAsync(1000)
      expect(agent).toMatchObject({ exitReason: OUTCOME_UNKNOWN, status: 'done' })

      store.settle('[ASYNC DELEGATION COMPLETE — deleg_1]\nintro\n\nStatus: interrupted   API calls: 2')
      expect(agent).toMatchObject({ exitReason: undefined, status: 'cancelled' })
    })
  })
})
