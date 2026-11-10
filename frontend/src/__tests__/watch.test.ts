import { afterEach, describe, expect, it, vi } from 'vitest'

import { liveSessionId } from '../core/ids.js'
import type { SettingsSource } from '../settings.js'
import { WatchApp } from '../watch/watchApp.js'

import { FakeGateway, fakeTern, key, stub } from './fakes.js'

const SPEC = { goal: 'Survey the repo', index: 0, name: 'Agent 1', sid: liveSessionId('s1'), startedAt: 0, subagent: 'sa-0-abcd' }

/** The child's stored rows as `session.transcript` serves them, in two writes. */
const FIRST = [
  { role: 'user', row_kind: 'message', text: 'Survey the repo', timestamp: 1 },
  { args: { command: 'ls' }, name: 'terminal', role: 'tool', row_kind: 'message', timestamp: 3, tool_call_id: 'c1' }
]
const LAST = [{ role: 'assistant', row_kind: 'message', text: 'Done.', timestamp: 4 }]

describe('the subagent pane', () => {
  afterEach(() => vi.useRealTimers())

  it("draws the child's stored transcript live from its own connection, and stops reading once the child ended", async () => {
    vi.useFakeTimers()
    const pages = [
      { available: true, next_cursor: 'c1', reset: true, rows: FIRST, running: true },
      { available: true, next_cursor: 'c1', reset: false, rows: [], running: true },
      { available: true, next_cursor: 'c2', reset: false, rows: LAST, running: false },
      { available: true, next_cursor: 'c2', reset: false, rows: [], running: false }
    ]
    const gw = new FakeGateway({
      replies: {
        'session.transcript': () => pages.shift(),
        'subagent.list': () => ({ subagents: [{ last_tool: 'terminal', model: 'fake-model', subagent_id: 'sa-0-abcd', tool_count: 2 }] })
      }
    })
    const tern = fakeTern()
    const app = new WatchApp(tern.session, gw.client, SPEC, stub<SettingsSource>({ load: () => ({}) }))
    const done = app.run()

    gw.event({ payload: {}, type: 'gateway.ready' })
    await vi.advanceTimersByTimeAsync(0)

    expect(gw.sent('session.transcript')[0]).toEqual({ limit: 200, order: 'oldest', session_id: 's1', subagent_id: 'sa-0-abcd' })
    expect(app.transcript.entries.map(e => e.kind)).toEqual(['user', 'turn'])

    await vi.advanceTimersByTimeAsync(1000)
    const turn = app.transcript.entries.at(-1)
    expect(turn?.kind === 'turn' ? turn.blocks.map(b => b.kind) : []).toEqual(['tool', 'text'])

    // The child ended and the reads caught up: no more reads of either kind.
    const sent = gw.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(gw.calls).toHaveLength(sent)
    expect(pages).toEqual([])

    tern.press(key('d', { ctrl: true }))
    expect(await done).toBe(0)
  })
})
