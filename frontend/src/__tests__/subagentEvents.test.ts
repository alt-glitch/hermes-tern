// The `subagent.*` events a real gateway streams for a delegated batch, as the lab recorded them
// (fixtures/subagent-events.jsonl: the `delegate…` prompt, three background children). They alone
// make each row's whole life: queued, running with its tool, then its end and summary.

import type { SubagentEventPayload, ToolCompletePayload, ToolStartPayload } from '@hermes/shared/gateway-events'
import { describe, expect, it, vi } from 'vitest'

import type { SubagentEventType } from '../agents/rows.js'
import { Agents } from '../agents/store.js'
import { liveSessionId } from '../core/ids.js'
import { Transcript } from '../transcript/store.js'

import { FakeGateway, stub } from './fakes.js'
import { fixture } from './replays.js'

type Recorded =
  | { type: 'tool.start'; payload: ToolStartPayload }
  | { type: 'tool.complete'; payload: ToolCompletePayload }
  | { type: SubagentEventType; payload: SubagentEventPayload }

const RECORDED: Recorded[] = fixture('subagent-events').map(line => stub<Recorded>(line))

/** Replays the recording up to (not including) the first event `stop` matches. */
function replay(stop: (ev: Recorded, i: number) => boolean = () => false, gw = new FakeGateway()) {
  const transcript = new Transcript()
  const agents = new Agents({ changed: () => undefined, gw: gw.client, sid: liveSessionId('s1'), transcript })
  transcript.messageStart(0)

  for (const [i, ev] of RECORDED.entries()) {
    if (stop(ev, i)) {
      break
    }

    if (ev.type === 'tool.start') {
      transcript.toolStart(ev.payload, i)
    } else if (ev.type === 'tool.complete') {
      transcript.toolComplete(ev.payload, i)
      agents.scan(i)
    } else {
      agents.apply(ev.type, ev.payload, i)
    }
  }

  return { agents, gw }
}

describe('a recorded delegated batch', () => {
  it('shows each row running its tool from the events alone', () => {
    // Up to each child's first tool call.
    const tools = RECORDED.flatMap((ev, i) => (ev.type === 'subagent.tool' ? [i] : []))
    const { agents } = replay((_, i) => i > (tools[2] ?? 0))

    expect(agents.all().map(a => [a.id, a.status, a.tool, a.toolPreview])).toEqual([
      ['sa-0-5d819ec5', 'running', 'terminal', 'sleep 3 + 1 command'],
      ['sa-1-0858b989', 'running', 'terminal', 'sleep 3 + 1 command'],
      ['sa-2-27050a21', 'running', 'terminal', 'sleep 3 + 1 command']
    ])
  })

  it('ends each row with its status, summary, duration and counts, polling nothing', () => {
    const { agents, gw } = replay()

    expect(agents.running()).toEqual([])
    expect(agents.all().map(a => [a.goal, a.status, a.toolCount, a.calls, a.summary?.split('\n')[0]])).toEqual([
      ['Survey the repository layout and name the top-level folders', 'done', 2, 3, 'Finished the delegated task.'],
      ['Read the clock twice, a few seconds apart', 'done', 2, 3, 'Finished the delegated task.'],
      ['Count the markdown files under the current folder', 'done', 2, 3, 'Finished the delegated task.']
    ])
    expect(agents.all().every(a => a.model === 'fake-model' && (a.duration ?? 0) > 10_000)).toBe(true)
    // The events told every row's state: no `subagent.list` poll ran.
    expect(gw.sent('subagent.list')).toEqual([])
  })

  it("puts a nested child's events under its parent, and takes its tool from subagent.list", async () => {
    const list = { subagents: [{ depth: 1, last_tool: 'terminal', parent_id: 'sa-1-0858b989', subagent_id: 'sa-0-inner', tool_count: 1 }] }
    const gw = new FakeGateway({ replies: { 'subagent.list': () => list } })
    const { agents } = replay(undefined, gw)

    agents.apply('subagent.start', {
      delegation_id: 'deleg_inner',
      depth: 1,
      goal: 'Look closer',
      parent_id: 'sa-1-0858b989',
      subagent_id: 'sa-0-inner',
      task_count: 1,
      task_index: 0
    })

    expect(agents.all().map(a => [a.id, a.depth ?? 0, a.name])).toEqual([
      ['sa-0-5d819ec5', 0, undefined],
      ['sa-1-0858b989', 0, undefined],
      ['sa-0-inner', 1, 'Agent 2.1'],
      ['sa-2-27050a21', 0, undefined]
    ])

    // The gateway forwards a nested child's start and end only: the list tells its tool.
    await vi.waitFor(() => expect(agents.running().map(a => [a.id, a.tool, a.toolCount])).toEqual([['sa-0-inner', 'terminal', 1]]))
  })
})
