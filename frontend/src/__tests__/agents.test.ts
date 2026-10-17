import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GatewayClient } from '@tui/gatewayClient.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseLiveLog } from '../agents/liveLog.js'
import { Agents } from '../agents/store.js'
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
    store = new Agents({ changed: () => changes++, gw, sid: 's1', transcript })

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
    store = new Agents({ changed: () => changes++, gw: { request } as unknown as GatewayClient, sid: 's1', transcript })

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
    store = new Agents({ changed: () => undefined, gw: { request } as unknown as GatewayClient, sid: 's1', transcript })

    store.scan()

    expect(request).not.toHaveBeenCalled()
  })

  it('pauses and resumes new spawns through delegation.pause, keeping the flag', async () => {
    const request = vi.fn(async (_method: string, params: { paused: boolean }) => ({ paused: params.paused }))
    let changes = 0
    store = new Agents({ changed: () => changes++, gw: { request } as unknown as GatewayClient, sid: 's1', transcript: new Transcript() })

    expect(store.paused).toBeUndefined()
    expect(await store.pause(true)).toBe(true)
    expect(request).toHaveBeenCalledWith('delegation.pause', { paused: true, session_id: 's1' })
    expect(store.paused).toBe(true)
    expect(await store.pause(false)).toBe(false)
    expect(store.paused).toBe(false)
    expect(changes).toBe(2)
  })
})
