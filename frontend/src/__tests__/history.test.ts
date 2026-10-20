import type { JSX } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import type { Block, Entry, ToolCall, TurnEntry } from '../model.js'
import { Transcript } from '../transcript.js'
import { internalNotice } from '../transcript/messages.js'
import { toolNode } from '../view/tools/shell.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'

interface Node {
  k: string
  p?: Record<string, unknown>
  c?: Node[]
}

const tree = (n: JSX.Element): Node => JSON.parse(JSON.stringify(n)) as Node

function words(n: Node): string[] {
  const spans = Array.isArray(n.p?.spans) ? (n.p.spans as { t: string }[]).map(s => s.t) : []

  return [...spans, ...(typeof n.p?.text === 'string' && n.k === 'md' ? [n.p.text] : []), ...(n.c ?? []).flatMap(words)]
}

function roles(n: Node): string[] {
  return [...(typeof n.p?.role === 'string' ? [n.p.role] : []), ...(n.c ?? []).flatMap(roles)]
}

const cx: TranscriptContext = { copy: () => {}, now: 0, welcome: {} as never }

function load(messages: object[]): Transcript {
  const t = new Transcript()
  t.load(messages as never)

  return t
}

const turns = (entries: readonly Entry[]) => entries.filter((e): e is TurnEntry => e.kind === 'turn')
const texts = (turn: TurnEntry) => turn.blocks.flatMap(b => (b.kind === 'text' ? [b.text] : []))
const thoughts = (turn: TurnEntry) => turn.blocks.flatMap(b => (b.kind === 'thinking' ? [b.text] : []))
const toolsOf = (turn: TurnEntry) => turn.blocks.flatMap((b: Block) => (b.kind === 'tool' ? [b.call] : []))

const NOTICE = 'Your request was not processed. Send it again if you still want me to carry it out.'

describe('resumed failed and interrupted turns', () => {
  it('rebuilds the error card from the failed_turn boundary, not an answer', () => {
    const t = load([
      { role: 'user', text: 'hi', timestamp: 1 },
      {
        display_kind: 'failed_turn',
        display_metadata: JSON.stringify({
          error: 'HTTP 400: This request is not valid.',
          error_surface: { code: 'format_error', layer: 'provider' }
        }),
        role: 'assistant',
        text: NOTICE,
        timestamp: 2
      }
    ])

    const [turn] = turns(t.entries)
    expect(texts(turn!)).toEqual([])
    expect(turn?.end).toMatchObject({ code: '400', error: 'This request is not valid.', hint: NOTICE, status: 'error' })
  })

  it('keeps a boundary without metadata as the failure advice alone, said once', () => {
    const t = load([
      { role: 'user', text: 'hi', timestamp: 1 },
      { display_kind: 'failed_turn', role: 'assistant', text: NOTICE, timestamp: 2 }
    ])

    const [turn] = turns(t.entries)
    expect(turn?.end).toMatchObject({ hint: NOTICE, status: 'error' })
    expect(turn?.end.status === 'error' && turn.end.error).toBeUndefined()

    const n = tree(entryNode(turn!, `main.${turn!.id}`, cx))
    expect(roles(n)).toContain('omp.error')
    expect(roles(n)).not.toContain('omp.error.message')
    expect(words(n).filter(w => w === NOTICE)).toHaveLength(1)
  })

  it('marks a reply the user stopped halfway as interrupted', () => {
    const t = load([
      { role: 'user', text: 'write it', timestamp: 1 },
      { display_metadata: { interrupted: true }, role: 'assistant', text: 'Here is the start', timestamp: 2 }
    ])

    const [turn] = turns(t.entries)
    expect(turn!.end.status).toBe('interrupted')
    expect(texts(turn!)).toEqual(['Here is the start'])
  })
})

describe('resumed thinking', () => {
  it('reads reasoning_content and readable reasoning_details, never encrypted blocks', () => {
    const t = load([
      { role: 'user', text: 'a', timestamp: 1 },
      { reasoning: '', reasoning_content: 'Content thought.', role: 'assistant', text: 'One.', timestamp: 2 },
      { role: 'user', text: 'b', timestamp: 3 },
      {
        reasoning_details: JSON.stringify([
          { data: 'gAAAA', type: 'reasoning.encrypted' },
          { text: 'Detail thought.', type: 'reasoning.text' },
          { summary: '**Summary** thought.', type: 'reasoning.summary' },
          { signature: 'sig', thinking: 'Signed thought.', type: 'thinking' }
        ]),
        role: 'assistant',
        text: 'Two.',
        timestamp: 4
      },
      { role: 'user', text: 'c', timestamp: 5 },
      { reasoning_details: [{ data: 'gAAAA', type: 'reasoning.encrypted' }], role: 'assistant', text: 'Three.', timestamp: 6 }
    ])

    expect(turns(t.entries).map(thoughts)).toEqual([
      ['Content thought.'],
      ['Detail thought.\n\n**Summary** thought.\n\nSigned thought.'],
      []
    ])
  })

  it('prefers display_reasoning, the thought with commentary taken out, even when empty', () => {
    const t = load([
      { role: 'user', text: 'a', timestamp: 1 },
      { display_reasoning: 'Clean thought.', reasoning: 'Raw thought. Note to user.', role: 'assistant', text: 'A.', timestamp: 2 },
      { role: 'user', text: 'b', timestamp: 3 },
      { display_reasoning: '', reasoning: 'Note to user.', role: 'assistant', text: 'B.', timestamp: 4 }
    ])

    expect(turns(t.entries).map(thoughts)).toEqual([['Clean thought.'], []])
  })
})

describe('resumed commentary (Codex providers)', () => {
  it('shows display_commentary as interim notes before the reply, and display_content over the raw text', () => {
    const t = load([
      { role: 'user', text: 'go', timestamp: 1 },
      { display_commentary: ['Checking the repo.', ' '], role: 'assistant', text: '', timestamp: 2 },
      { args: { command: 'ls' }, name: 'terminal', role: 'tool', tool_call_id: 'c1' },
      { display_content: 'Done.', role: 'assistant', text: 'Raw commentary. Done.', timestamp: 3 }
    ])

    const [turn] = turns(t.entries)
    expect(texts(turn!)).toEqual(['Checking the repo.', 'Done.'])
  })

  it('keeps commentary stored as the reply too only once', () => {
    const t = load([
      { role: 'user', text: 'go', timestamp: 1 },
      { display_commentary: ['First.', 'Second.'], role: 'assistant', text: 'First.\n\nSecond.', timestamp: 2 }
    ])

    expect(texts(turns(t.entries)[0]!)).toEqual(['First.\n\nSecond.'])
  })
})

describe('resumed edit previews', () => {
  it('takes the stored inline diff, so a write_file over a file shows its changes, not the whole file', () => {
    const inline = '\x1b[1ma/x.ts → b/x.ts\x1b[0m\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n'
    const t = load([
      { role: 'user', text: 'edit', timestamp: 1 },
      {
        args: { content: 'a\nc\n', path: 'x.ts' },
        display_metadata: JSON.stringify({ tool_result_metadata: { inline_diff: inline } }),
        name: 'write_file',
        role: 'tool',
        tool_call_id: 'c1'
      }
    ])

    const call = toolsOf(turns(t.entries)[0]!)[0] as ToolCall
    expect(call.diff).toBe(inline)

    const n = tree(toolNode(call, 0))
    expect(JSON.stringify(n)).toContain('@@ -1,2 +1,2 @@')
    expect(JSON.stringify(n)).not.toContain('"numbers":true')
  })
})

describe('async delegation notices without display_kind', () => {
  it('names a single finished and a failed subagent', () => {
    expect(internalNotice('[ASYNC DELEGATION COMPLETE — deleg_1]\nA background subagent…')).toBe('Subagent finished')
    expect(internalNotice('[ASYNC DELEGATION TASK FAILED — deleg_1, task 2/3]\nOne subagent…')).toBe('Subagent failed')
    expect(internalNotice('[Continuing toward your standing goal]\nGoal: make the tests pass')).toBe('Continuing toward the goal')
    expect(internalNotice('[/loop wakeup #3, every 2m] Recurring task: say hi')).toBe('Loop run #3 · every 2m')
    expect(internalNotice('[/loop wakeup #1]\nRecurring task')).toBe('Loop run #1')
    expect(internalNotice('[IMPORTANT: Background process proc_1 completed normally (exit code 0). Command: ls]')).toBe('Background command finished')
    expect(internalNotice('[IMPORTANT: Background process proc_1 exited (exit code 2). Command: ls]')).toBe('Background command exited (exit 2)')

    const t = load([
      { role: 'user', text: 'fan out', timestamp: 1 },
      { role: 'assistant', text: 'Sent.', timestamp: 2 },
      { role: 'user', text: '[ASYNC DELEGATION TASK FAILED — d1, task 1/2]\nboom', timestamp: 3 },
      { role: 'assistant', text: 'Retrying.', timestamp: 4 }
    ])

    expect(t.entries.filter(e => e.kind === 'user')).toHaveLength(1)
    expect(turns(t.entries).map(e => e.continued)).toEqual([undefined, 'Subagent failed'])
  })
})

describe('Transcript.started: a prompt Hermes queued itself', () => {
  it('a loop run becomes the reason line of the turn it opens, not a bubble', () => {
    const t = new Transcript()
    t.messageStart()
    t.started('[/loop wakeup #2, every 2m] Recurring task: say hi')
    expect(t.entries.map(e => e.kind)).toEqual(['turn'])
    expect(t.live?.continued).toBe('Loop run #2 · every 2m')
  })

  it('before its turn starts, the turn takes it', () => {
    const t = new Transcript()
    t.started('[Continuing toward your standing goal]\nGoal: ship')
    t.messageStart()
    expect(t.entries.map(e => e.kind)).toEqual(['turn'])
    expect(t.live?.continued).toBe('Continuing toward the goal')
  })
})
