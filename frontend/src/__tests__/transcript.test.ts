import type { TranscriptMessage } from '@hermes/shared/gateway-events'
import { describe, expect, it } from 'vitest'

import type { Block, Entry, ToolCall, TurnEntry } from '../model.js'
import { Transcript } from '../transcript.js'

function turnOf(entries: Entry[]): TurnEntry {
  const turn = entries.findLast(e => e.kind === 'turn')

  if (turn?.kind !== 'turn') {
    throw new Error('no turn')
  }

  return turn
}

function texts(turn: TurnEntry): string[] {
  return turn.blocks.flatMap(b => (b.kind === 'text' ? [b.text] : []))
}

function tools(turn: TurnEntry): ToolCall[] {
  return turn.blocks.flatMap(b => (b.kind === 'tool' ? [b.call] : []))
}

function kinds(turn: TurnEntry): Block['kind'][] {
  return turn.blocks.map(b => b.kind)
}

describe('Transcript', () => {
  it('keeps streaming into the live turn after a notice lands mid-turn', () => {
    const t = new Transcript()
    t.start(0)
    t.text('Working on it.', 1)
    t.notice('Wait for the current turn to finish.', 'warning')
    t.text(' Still here.', 2)
    t.complete({ status: 'complete', text: 'Working on it. Still here.' }, 3)

    const turns = t.entries.filter(e => e.kind === 'turn')
    expect(turns).toHaveLength(1)
    expect(texts(turnOf(t.entries))).toEqual(['Working on it. Still here.'])
    expect(turnOf(t.entries).status).toBe('done')
    expect(t.entries.at(-1)?.kind).toBe('notice')
    expect(t.live).toBeUndefined()
  })

  it('hydrates a resumed session’s running turn so its stream continues in place', () => {
    const t = new Transcript()
    t.load([{ role: 'user', text: 'earlier' }])
    t.inflight({ assistant: 'Half way', streaming: true, user: 'keep going' }, 10)
    t.text(' there.', 11)
    t.complete({ status: 'complete', text: 'Half way there.' }, 12)

    expect(t.entries.map(e => e.kind)).toEqual(['user', 'user', 'turn'])
    expect(texts(turnOf(t.entries))).toEqual(['Half way there.'])
  })

  it('forgets the live turn on clear and load', () => {
    const t = new Transcript()
    t.start(0)
    t.clear()
    expect(t.live).toBeUndefined()

    t.start(1)
    t.load([{ role: 'user', text: 'hi' }])
    expect(t.live).toBeUndefined()
    t.text('fresh', 2)
    expect(t.entries.filter(e => e.kind === 'turn')).toHaveLength(1)
  })

  it('starts a new text block after an interim seal', () => {
    const t = new Transcript()
    t.start(0)
    t.text('Let me look ', 1)
    t.text('around first.', 2)
    t.interim('Let me look around first.', { alreadyStreamed: true }, 3)
    t.text('Found it.', 4)

    // The seal is an empty block the next delta fills: two blocks, not one run-on.
    expect(texts(turnOf(t.entries))).toEqual(['Let me look around first.', 'Found it.'])
  })

  it('adds an interim text that never streamed, then seals it', () => {
    const t = new Transcript()
    t.start(0)
    t.interim('Checking the tests.', { alreadyStreamed: false }, 1)
    t.text('Done.', 2)
    t.complete({ status: 'complete', text: 'Done.' }, 3)

    expect(texts(turnOf(t.entries))).toEqual(['Checking the tests.', 'Done.'])
  })

  it('does not repeat message.complete text that streamed after an interim seal', () => {
    const t = new Transcript()
    t.start(0)
    t.text('Looking first.', 1)
    t.interim('Looking first.', { alreadyStreamed: true }, 2)
    t.text('All done.', 3)
    t.complete({ status: 'complete', text: 'All done.' }, 4)

    const turn = turnOf(t.entries)
    expect(texts(turn)).toEqual(['Looking first.', 'All done.'])
    expect(turn.status).toBe('done')
  })

  it('takes message.complete text when nothing streamed after the last tool', () => {
    const t = new Transcript()
    t.start(0)
    t.toolStart({ args: { command: 'ls' }, name: 'terminal', tool_id: 'c1' }, 1)
    t.toolComplete({ name: 'terminal', result: { exit_code: 0, output: 'a' }, tool_id: 'c1' }, 2)
    t.complete({ status: 'complete', text: 'Listed.' }, 3)

    expect(kinds(turnOf(t.entries))).toEqual(['tool', 'text'])
    expect(texts(turnOf(t.entries))).toEqual(['Listed.'])
  })

  it('ignores reasoning.available once reasoning streamed', () => {
    const t = new Transcript()
    t.start(0)
    t.reasoning('Thinking it ', 1)
    t.reasoning('through.', 2)
    t.reasoningBlock('A different summary.', 3)

    const thoughts = turnOf(t.entries).blocks.filter(b => b.kind === 'thinking')
    expect(thoughts).toHaveLength(1)
    expect(thoughts[0]?.kind === 'thinking' && thoughts[0].text).toBe('Thinking it through.')
  })

  it('ignores reasoning.available that repeats the streamed answer', () => {
    const t = new Transcript()
    t.start(0)
    t.text('Hi! What should we work on?', 1)
    t.reasoningBlock('Hi! What should we work on?', 2)

    expect(kinds(turnOf(t.entries))).toEqual(['text'])
  })

  it('keeps reasoning.available from a provider that does not stream reasoning', () => {
    const t = new Transcript()
    t.start(0)
    t.reasoningBlock('Weighing the options.', 1)
    t.text('Use SQLite.', 2)

    expect(kinds(turnOf(t.entries))).toEqual(['thinking', 'text'])
  })

  it('opens a call from tool.complete without tool.start', () => {
    const t = new Transcript()
    t.start(0)
    t.toolComplete(
      { args: { path: 'a.py' }, duration_s: 0.25, name: 'read_file', result: { content: '1|x' }, tool_id: 'c1' },
      5
    )

    const [call] = tools(turnOf(t.entries))
    expect(call).toMatchObject({ args: { path: 'a.py' }, duration: 250, id: 'c1', name: 'read_file', status: 'done' })
  })

  it('fails a terminal call with a non-zero exit and cancels an interrupted one', () => {
    const t = new Transcript()
    t.start(0)
    t.toolComplete({ name: 'terminal', result: { error: null, exit_code: 2, output: 'boom' }, tool_id: 'c1' }, 1)
    t.toolComplete(
      {
        name: 'terminal',
        result: { error: null, exit_code: 130, output: 'step 1\n\n[Command interrupted]' },
        tool_id: 'c2'
      },
      2
    )

    expect(tools(turnOf(t.entries)).map(c => c.status)).toEqual(['error', 'cancelled'])
  })

  it('cancels calls still running when the turn is interrupted', () => {
    const t = new Transcript()
    t.start(0)
    t.toolStart({ name: 'terminal', tool_id: 'c1' }, 1)
    t.complete({ status: 'interrupted' }, 3)

    const turn = turnOf(t.entries)
    expect(turn.status).toBe('interrupted')
    expect(tools(turn)[0]).toMatchObject({ duration: 2, status: 'cancelled' })
  })

  it('splits a failed request into code, message and advice', () => {
    const t = new Transcript()
    t.start(0)
    t.complete(
      {
        error: 'HTTP 500: upstream exploded',
        error_surface: { code: 'server_error', layer: 'provider', retryable: true },
        status: 'error',
        text: 'custom returned a server error. Wait and send /retry.\n\nProvider said: HTTP 500: upstream exploded'
      },
      1
    )

    expect(turnOf(t.entries)).toMatchObject({
      error: 'upstream exploded',
      errorCode: '500',
      errorHint: 'custom returned a server error. Wait and send /retry.',
      status: 'error'
    })
    expect(texts(turnOf(t.entries))).toEqual([])
  })

  it('reports each turn its share of the session usage', () => {
    const t = new Transcript()
    t.usageBase({ input: 100, output: 10, total: 110 })
    t.start(0)
    t.complete({ status: 'complete', text: 'a', usage: { input: 1300, output: 190, total: 1490 } }, 1)
    t.start(2)
    t.complete({ status: 'complete', text: 'b', usage: { input: 2500, output: 370, total: 2870 } }, 3)

    const turns = t.entries.filter(e => e.kind === 'turn')
    expect(turns.map(e => e.kind === 'turn' && e.usage?.total)).toEqual([1380, 1380])
  })

  it('shows todo_list args while running and the snapshot once done', () => {
    const t = new Transcript()
    t.start(0)
    t.toolStart(
      { args: { todos: [{ content: 'Plan', id: '1', status: 'in_progress' }] }, name: 'todo_list', tool_id: 'c1' },
      1
    )

    expect(tools(turnOf(t.entries))[0]?.todos).toEqual([{ content: 'Plan', id: '1', status: 'in_progress' }])

    t.toolComplete({ name: 'todo_list', todos: [{ content: 'Plan', id: '1', status: 'completed' }], tool_id: 'c1' }, 2)
    t.todos([
      { content: 'Plan', id: '1', status: 'completed' },
      { content: 'Ship', id: '2', status: 'pending' }
    ])

    expect(tools(turnOf(t.entries))[0]?.todos?.map(x => x.status)).toEqual(['completed', 'pending'])
  })

  it('folds background subagents into the delegating call after its turn ended', () => {
    const t = new Transcript()
    t.start(0)
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
    t.user('next', 4)
    t.start(5)

    const base = { delegation_id: 'deleg_1', task_count: 2 }
    t.subagent('subagent.start', { ...base, goal: 'b', subagent_id: 's1', task_index: 1 }, 6)
    t.subagent('subagent.start', { ...base, goal: 'a', subagent_id: 's0', task_index: 0 }, 6)
    t.subagent(
      'subagent.tool',
      { ...base, goal: 'a', subagent_id: 's0', task_index: 0, tool_name: 'terminal', tool_preview: 'ls' },
      7
    )
    t.subagent(
      'subagent.complete',
      { ...base, api_calls: 2, goal: 'a', status: 'completed', subagent_id: 's0', summary: 'Done', task_index: 0 },
      9
    )

    const call = tools(turnOf(t.entries.slice(0, 1)))[0]
    expect(call?.subagents?.map(a => [a.id, a.status, a.calls])).toEqual([
      ['s0', 'done', 2],
      ['s1', 'running', 0]
    ])
    expect(tools(turnOf(t.entries))).toEqual([])
  })

  it('loads resumed messages with tool calls, edit results and bridged todos', () => {
    const t = new Transcript()

    const messages: TranscriptMessage[] = [
      { role: 'user', text: 'please tour', timestamp: 1 },
      { reasoning: 'Planning.', role: 'assistant', text: '', timestamp: 2 },
      {
        args: { arguments: { todos: [{ content: 'Look', id: '1', status: 'completed' }] }, name: 'todo_list' },
        name: 'tool_call',
        role: 'tool',
        tool_call_id: 'c1'
      },
      { role: 'assistant', text: 'Looking.', timestamp: 3 },
      { args: { command: 'ls' }, context: 'ls', name: 'terminal', role: 'tool', tool_call_id: 'c2' },
      {
        args: { path: 'src/app.py' },
        content: '{"success": true, "diff": "--- a\\n+++ b\\n@@ -1 +1 @@\\n-a\\n+b\\n"}',
        name: 'patch',
        role: 'tool',
        tool_call_id: 'c3'
      },
      {
        args: { path: 'x' },
        content: '{"error": "Refusing to overwrite"}',
        name: 'write_file',
        role: 'tool',
        tool_call_id: 'c4'
      },
      { role: 'assistant', text: 'Done.', timestamp: 4 }
    ]

    t.load(messages)

    expect(t.entries.map(e => e.kind)).toEqual(['user', 'turn'])
    const turn = turnOf(t.entries)
    expect(kinds(turn)).toEqual(['thinking', 'tool', 'text', 'tool', 'tool', 'tool', 'text'])
    expect(tools(turn).map(c => [c.name, c.status])).toEqual([
      ['todo_list', 'done'],
      ['terminal', 'done'],
      ['patch', 'done'],
      ['write_file', 'error']
    ])
    expect(tools(turn)[0]?.todos).toEqual([{ content: 'Look', id: '1', status: 'completed' }])
    expect(tools(turn)[2]?.result).toContain('@@ -1 +1 @@')
    expect(turn.status).toBe('done')
  })
})
