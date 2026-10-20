import type { TranscriptMessage } from '@hermes/shared/gateway-events'
import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { Block, Entry, ToolCall, TurnEntry } from '../model.js'
import { Transcript } from '../transcript.js'
import { findCall } from '../transcript/calls.js'

function turnOf(entries: readonly Entry[]): TurnEntry {
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
    t.messageStart(0)
    t.text('Working on it.', 1)
    t.notice('Wait for the current turn to finish.', 'warning')
    t.text(' Still here.', 2)
    t.complete({ status: 'complete', text: 'Working on it. Still here.' }, 3)

    const turns = t.entries.filter(e => e.kind === 'turn')
    expect(turns).toHaveLength(1)
    expect(texts(turnOf(t.entries))).toEqual(['Working on it. Still here.'])
    expect(turnOf(t.entries).end.status).toBe('done')
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

  it('forgets the live turn on reset and load', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.reset({ session: 'other', usage: undefined })
    expect(t.live).toBeUndefined()
    expect(t.entries.map(e => e.kind)).toEqual(['welcome'])

    t.messageStart(1)
    t.load([{ role: 'user', text: 'hi' }])
    expect(t.live).toBeUndefined()
    t.text('fresh', 2)
    expect(t.entries.filter(e => e.kind === 'turn')).toHaveLength(1)
  })

  it('starts a new text block after an interim seal', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.text('Let me look ', 1)
    t.text('around first.', 2)
    t.interim('Let me look around first.', { alreadyStreamed: true }, 3)
    t.text('Found it.', 4)

    // The seal is an empty block the next delta fills: two blocks, not one run-on.
    expect(texts(turnOf(t.entries))).toEqual(['Let me look around first.', 'Found it.'])
  })

  it('adds an interim text that never streamed, then seals it', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.interim('Checking the tests.', { alreadyStreamed: false }, 1)
    t.text('Done.', 2)
    t.complete({ status: 'complete', text: 'Done.' }, 3)

    expect(texts(turnOf(t.entries))).toEqual(['Checking the tests.', 'Done.'])
  })

  it('does not repeat message.complete text that streamed after an interim seal', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.text('Looking first.', 1)
    t.interim('Looking first.', { alreadyStreamed: true }, 2)
    t.text('All done.', 3)
    t.complete({ status: 'complete', text: 'All done.' }, 4)

    const turn = turnOf(t.entries)
    expect(texts(turn)).toEqual(['Looking first.', 'All done.'])
    expect(turn.end.status).toBe('done')
  })

  it('takes message.complete text when nothing streamed after the last tool', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.toolStart({ args: { command: 'ls' }, name: 'terminal', tool_id: 'c1' }, 1)
    t.toolComplete({ name: 'terminal', result: { exit_code: 0, output: 'a' }, tool_id: 'c1' }, 2)
    t.complete({ status: 'complete', text: 'Listed.' }, 3)

    expect(kinds(turnOf(t.entries))).toEqual(['tool', 'text'])
    expect(texts(turnOf(t.entries))).toEqual(['Listed.'])
  })

  it('ignores reasoning.available once reasoning streamed', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.reasoning('Thinking it ', 1)
    t.reasoning('through.', 2)
    t.reasoningBlock('A different summary.', 3)

    const thoughts = turnOf(t.entries).blocks.filter(b => b.kind === 'thinking')
    expect(thoughts).toHaveLength(1)
    expect(thoughts[0]?.kind === 'thinking' && thoughts[0].text).toBe('Thinking it through.')
  })

  it('ignores reasoning.available that repeats the streamed answer', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.text('Hi! What should we work on?', 1)
    t.reasoningBlock('Hi! What should we work on?', 2)

    expect(kinds(turnOf(t.entries))).toEqual(['text'])
  })

  it('keeps reasoning.available from a provider that does not stream reasoning', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.reasoningBlock('Weighing the options.', 1)
    t.text('Use SQLite.', 2)

    expect(kinds(turnOf(t.entries))).toEqual(['thinking', 'text'])
  })

  it('keeps a Mixture-of-Agents reference as its own labelled, sealed thought', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.reasoning('Planning.', 1)
    t.reference('Reference 1/2 · gpt-5', '  Use SQLite.  ', 2)
    t.reasoning('Next.', 3)

    expect(turnOf(t.entries).blocks).toMatchObject([
      { endedAt: 2, kind: 'thinking', text: 'Planning.' },
      { endedAt: 2, kind: 'thinking', label: 'Reference 1/2 · gpt-5', text: 'Use SQLite.' },
      { kind: 'thinking', text: 'Next.' }
    ])
  })

  it('keeps reasoning.available after a reference answer (it is not the agent’s own thought)', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.reference('Reference · gpt-5', 'Use SQLite.', 1)
    t.reasoningBlock('Weighing the references.', 2)

    expect(kinds(turnOf(t.entries))).toEqual(['thinking', 'thinking'])
  })

  it('opens a call from tool.complete without tool.start', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.toolComplete(
      { args: { path: 'a.py' }, duration_s: 0.25, name: 'read_file', result: { content: '1|x' }, tool_id: 'c1' },
      5
    )

    const [call] = tools(turnOf(t.entries))
    expect(call).toMatchObject({ args: { path: 'a.py' }, id: 'c1', name: 'read_file', outcome: { duration: 250, kind: 'done' } })
  })

  it('fails a terminal call with a non-zero exit and cancels an interrupted one', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.toolComplete({ name: 'terminal', result: { error: null, exit_code: 2, output: 'boom' }, tool_id: 'c1' }, 1)
    t.toolComplete(
      {
        name: 'terminal',
        result: { error: null, exit_code: 130, output: 'step 1\n\n[Command interrupted]' },
        tool_id: 'c2'
      },
      2
    )

    expect(tools(turnOf(t.entries)).map(c => c.outcome.kind)).toEqual(['error', 'cancelled'])
  })

  it('cancels calls still running when the turn is interrupted', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.toolStart({ name: 'terminal', tool_id: 'c1' }, 1)
    t.complete({ status: 'interrupted' }, 3)

    const turn = turnOf(t.entries)
    expect(turn.end.status).toBe('interrupted')
    expect(tools(turn)[0]).toMatchObject({ outcome: { duration: 2, kind: 'cancelled' } })
  })

  it('keeps each call, compaction and turn the same object as it ends: only its outcome, state or end is replaced', () => {
    const t = new Transcript()
    const turn = t.messageStart(0)
    t.toolStart({ name: 'terminal', tool_id: 'c1' }, 1)
    const call = t.call(toolCallId('c1'))
    const compaction = t.compacting({ at: 2, before: 90_000 })

    t.toolComplete({ name: 'terminal', result: { exit_code: 0, output: 'ok' }, tool_id: 'c1' }, 3)
    t.compacted(4, { after: 20_000 })
    t.complete({ status: 'complete', text: 'done' }, 5)

    expect(turnOf(t.entries)).toBe(turn)
    expect(tools(turn)[0]).toBe(call)
    expect(call?.outcome).toEqual({ duration: 2, kind: 'done' })
    expect(compaction.state).toEqual({ after: 20_000, endedAt: 4, status: 'done' })
    expect(turn.blocks.some(b => b.kind === 'compaction' && b.compaction === compaction)).toBe(true)
    expect(turn.end).toEqual({ endedAt: 5, status: 'done' })
  })

  it('splits a failed request into code, message and advice', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.complete(
      {
        error: 'HTTP 500: upstream exploded',
        error_surface: { code: 'server_error', layer: 'provider', retryable: true },
        status: 'error',
        text: 'custom returned a server error. Wait and send /retry.\n\nProvider said: HTTP 500: upstream exploded'
      },
      1
    )

    expect(turnOf(t.entries).end).toMatchObject({
      code: '500',
      error: 'upstream exploded',
      hint: 'custom returned a server error. Wait and send /retry.',
      status: 'error'
    })
    expect(texts(turnOf(t.entries))).toEqual([])
  })

  it('reports each turn its share of the session usage', () => {
    const t = new Transcript()
    t.reset({ session: 'other', usage: { input: 100, output: 10, total: 110 } })
    t.messageStart(0)
    t.complete({ status: 'complete', text: 'a', usage: { input: 1300, output: 190, total: 1490 } }, 1)
    t.messageStart(2)
    t.complete({ status: 'complete', text: 'b', usage: { input: 2500, output: 370, total: 2870 } }, 3)

    const turns = t.entries.filter(e => e.kind === 'turn')
    expect(turns.map(e => e.kind === 'turn' && e.usage?.total)).toEqual([1380, 1380])
  })

  it("counts a turn from zero when the counters go back (a new agent's), not below it", () => {
    const t = new Transcript()
    t.usageTick({ prompt: 20_000, read: 15_000, total: 21_560 }, undefined)
    const turn = t.messageStart(0)
    t.usageTick({ prompt: 3_000, read: 2_250, total: 3_080 }, undefined)
    expect([turn.tickTokens, turn.cacheHit]).toEqual([3_080, 75])
  })

  it('shows todo_list args while running and the snapshot once done', () => {
    const t = new Transcript()
    t.messageStart(0)
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
    expect(tools(turn).map(c => [c.name, c.outcome.kind])).toEqual([
      ['todo_list', 'done'],
      ['terminal', 'done'],
      ['patch', 'done'],
      ['write_file', 'error']
    ])
    expect(tools(turn)[0]?.todos).toEqual([{ content: 'Look', id: '1', status: 'completed' }])
    expect(tools(turn)[2]?.result).toContain('@@ -1 +1 @@')
    expect(turn.end.status).toBe('done')
  })

  it('applies a merge:true todo call as a patch on the list before it, live and resumed', () => {
    const full = { todos: [{ content: 'Plan', id: '1', status: 'in_progress' }, { content: 'Build', id: '2', status: 'pending' }] }
    const patch = { merge: true, todos: [{ id: '1', status: 'completed' }, { content: 'Ship', id: '3', status: 'pending' }, { id: '4' }] }

    const merged = [
      { content: 'Plan', id: '1', status: 'completed' },
      { content: 'Build', id: '2', status: 'pending' },
      { content: 'Ship', id: '3', status: 'pending' }
    ]

    const live = new Transcript()
    live.messageStart(0)
    live.toolStart({ args: full, name: 'todo_list', tool_id: 'c1' }, 1)
    live.toolComplete({ name: 'todo_list', tool_id: 'c1' }, 2)
    live.toolStart({ args: patch, name: 'todo_list', tool_id: 'c2' }, 3)
    expect(tools(turnOf(live.entries))[1]?.todos).toEqual(merged)
    expect(live.currentTodos()).toEqual(merged)

    const resumed = new Transcript()
    resumed.load([
      { role: 'user', text: 'go', timestamp: 1 },
      { args: full, name: 'todo_list', role: 'tool', tool_call_id: 'c1' },
      { args: { arguments: patch, name: 'todo_list' }, name: 'tool_call', role: 'tool', tool_call_id: 'c2' }
    ])
    expect(resumed.currentTodos()).toEqual(merged)
    // The full list's own call keeps its own snapshot.
    expect(tools(turnOf(resumed.entries))[0]?.todos?.map(x => x.status)).toEqual(['in_progress', 'pending'])
  })

  it('treats the legacy `todo` tool as the todo list', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.toolStart({ args: { todos: [{ content: 'Plan', id: '1', status: 'pending' }] }, name: 'todo', tool_id: 'c1' }, 1)
    t.todos([{ content: 'Plan', id: '1', status: 'completed' }])
    expect(tools(turnOf(t.entries))[0]?.todos).toEqual([{ content: 'Plan', id: '1', status: 'completed' }])
  })

  it('finds a call by its tool id', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.toolStart({ args: { path: 'a.ts' }, name: 'read_file', tool_id: 'c1' }, 1)
    expect(t.call(toolCallId('c1'))?.name).toBe('read_file')
    expect(t.call(toolCallId('nope'))).toBeUndefined()
  })

  it('finds the newest call when a tool id repeats: the newest turn, its last block', () => {
    const call = (path: string): ToolCall => ({ args: { path }, argsText: path, context: '', id: toolCallId('c1'), name: 'read_file', outcome: { duration: 0, kind: 'done' }, startedAt: 0, via: { kind: 'direct' } })
    const turn = (...paths: string[]): TurnEntry => ({
      blocks: paths.map(path => ({ call: call(path), id: toolCallId('c1'), kind: 'tool' as const })),
      end: { status: 'done' },
      id: entryId('t'),
      kind: 'turn',
      rev: 0,
      startedAt: 0
    })
    const entries = [turn('a.ts', 'b.ts'), turn('c.ts', 'd.ts'), { id: entryId('n'), kind: 'notice' as const, text: '', tone: 'info' as const }]

    expect(findCall(entries, c => c.id === 'c1')?.call.argsText).toBe('d.ts')
    expect(findCall(entries, c => c.argsText === 'a.ts')?.turn).toBe(entries[0])
  })

  it('bumps the turn holding a call that changes outside the reducer', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.toolStart({ args: { command: 'sleep 9', background: true }, name: 'terminal', tool_id: 'c1' }, 1)
    t.complete({ status: 'complete' }, 2)
    t.messageStart(3)
    const revs = () => t.entries.flatMap(e => (e.kind === 'turn' ? [e.rev] : []))
    const call = tools(turnOf(t.entries.slice(0, 1)))[0]
    const [first = 0, second] = revs()

    if (!call) {
      throw new Error('no call')
    }

    t.mutateCall(call, c => {
      c.image = null
    })

    expect(call.image).toBeNull()
    // Only the turn holding the call.
    expect(revs()).toEqual([first + 1, second])

    // A call no turn holds changes nothing else.
    t.mutateCall({ ...call }, () => {})
    expect(revs()).toEqual([first + 1, second])
  })
})

// WP24: an event that comes after message.complete closed its turn opens no turn of its own.
describe('Transcript: late events after a turn ended', () => {
  /** A transcript whose one turn said `text` and ended. */
  function ended(text: string): Transcript {
    const t = new Transcript()
    t.messageStart(0)
    t.text(text, 1)
    t.complete({ status: 'complete', text }, 2)

    return t
  }

  const turns = (t: Transcript) => t.entries.filter(e => e.kind === 'turn')

  it('a late reasoning.available that repeats the answer, or says nothing, leaves no live turn', () => {
    const t = ended('The answer.')

    t.reasoningBlock('The answer.', 3)
    t.reasoningBlock('  ', 4)

    expect(t.live).toBeUndefined()
    expect(turns(t)).toHaveLength(1)
    expect(kinds(turnOf(t.entries))).toEqual(['text'])
  })

  it('a late reasoning.available with a thought of its own goes in the turn that ended', () => {
    const t = ended('The answer.')

    t.reasoningBlock('Why it is so.', 3)

    expect(t.live).toBeUndefined()
    expect(turns(t)).toHaveLength(1)
    expect(kinds(turnOf(t.entries))).toEqual(['text', 'thinking'])
  })

  it('a late tool.complete for a call never started goes in the turn that ended, settled', () => {
    const t = ended('Done.')

    t.toolComplete({ name: 'read_file', result: { content: 'x' }, tool_id: 'late' }, 3)

    expect(t.live).toBeUndefined()
    expect(turns(t)).toHaveLength(1)
    expect(tools(turnOf(t.entries)).map(c => [c.id, c.outcome.kind])).toEqual([['late', 'done']])
  })

  it('the next turn starts fresh after them, not inside the turn that ended', () => {
    const t = ended('First.')
    t.reasoningBlock('A late thought.', 3)
    t.toolComplete({ name: 'read_file', tool_id: 'late' }, 4)

    t.messageStart(5)
    t.text('Second.', 6)

    expect(turns(t)).toHaveLength(2)
    // Only its own text: the late thought and call stay with the turn they came after.
    expect(kinds(turnOf(t.entries))).toEqual(['text'])
  })

  it('a tool.complete with no turn ended here (a resumed session mid-turn) still opens the live turn', () => {
    const t = new Transcript()
    t.load([{ role: 'user', text: 'go' }])

    t.toolComplete({ name: 'read_file', tool_id: 'c1' }, 1)

    expect(t.live).toBeDefined()
    expect(tools(turnOf(t.entries)).map(c => c.id)).toEqual(['c1'])
  })
})
