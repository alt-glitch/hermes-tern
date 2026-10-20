import { describe, expect, it } from 'vitest'

import { entryId, subagentKey, toolCallId } from '../core/ids.js'
import type { Block, ToolCall, TurnEntry } from '../model.js'
import type { Todo } from '../model.js'
import { Transcript } from '../transcript/store.js'
import { durationCompact } from '../view/format.js'
import { planStep } from '../view/tools/cards/inline.js'
import { busyLabel, foldOf, liveLabel, parts, pieces, preparingLabel, presentTense, stepLabel, summarize, thoughtLine, thoughtTitle, type WorkItem } from '../workLog.js'

import { must } from './fakes.js'

const call = (name: string, args: Record<string, unknown> = {}, more: Partial<ToolCall> = {}): ToolCall => ({
  args,
  argsText: '',
  context: '',
  id: toolCallId(`${name}-${JSON.stringify(args)}`),
  name,
  startedAt: 0,
  outcome: { duration: 0, kind: 'done' },
  via: { kind: 'direct' },
  ...more
})

const tool = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ call: c, id: entryId(id), kind: 'tool' })
const text = (id: string, t = 'x'): Block => ({ id: entryId(id), kind: 'text', text: t })
const think = (id: string, t = 'hm'): Extract<Block, { kind: 'thinking' }> => ({ endedAt: 1, id: entryId(id), kind: 'thinking', startedAt: 0, text: t })

const turn = (blocks: Block[], more: Partial<TurnEntry> = {}): TurnEntry => ({
  blocks,
  end: { endedAt: 54_000, status: 'done' },
  id: entryId('t'),
  kind: 'turn',
  rev: 0,
  startedAt: 0,
  ...more
})

describe('summarize (t3code summarizeToolGroup)', () => {
  const sh = (command: string) => tool(command, call('terminal', { command }))
  const read = (path: string) => tool(path, call('read_file', { path }))

  it('counts by action and joins two with "and"', () => {
    expect(summarize([sh('ls'), sh('pwd'), read('a'), think('k')])).toBe('Ran 2 commands and read 1 file')
  })

  it('keeps the two that matter most and counts the rest as other actions', () => {
    const items: WorkItem[] = [
      read('a'),
      tool('s', call('search_files', { pattern: 'x' })),
      sh('ls'),
      tool('w', call('write_file', { path: 'n.md' })),
      read('b')
    ]

    expect(summarize(items)).toBe('Ran 1 command, changed 1 file, and performed 3 other actions')
  })

  it('counts edited files, not edits', () => {
    const edit = (id: string, path: string) => tool(id, call('patch', { path }))

    expect(summarize([edit('1', 'a.ts'), edit('2', 'a.ts'), edit('3', 'b.ts')])).toBe('Changed 2 files')
  })

  it('says Thought for thoughts alone', () => {
    expect(summarize([think('a')])).toBe('Thought')
    expect(summarize([think('a'), think('b')])).toBe('Thought (×2)')
  })
})

describe('pieces', () => {
  it('groups calls with the thoughts between them; text and Task cards break groups', () => {
    const blocks = [
      think('k0'),
      text('t0'),
      tool('a', call('terminal', { command: 'ls' })),
      think('k1'),
      tool('b', call('read_file', { path: 'x' })),
      tool('d', call('delegate_task')),
      tool('c', call('terminal', { command: 'pwd' }))
    ]

    expect(pieces(blocks).map(p => (p.kind === 'work' ? p.items.map(i => i.id) : p.block.id))).toEqual([
      ['k0'],
      't0',
      ['a', 'k1', 'b'],
      'd',
      ['c']
    ])
  })

  it('leaves a background process its own card', () => {
    const bg = tool('bg', call('terminal', { background: true, command: 'sleep 9' }))

    expect(pieces([bg]).map(p => p.kind)).toEqual(['block'])
  })
})

describe('todo lists in a turn', () => {
  const todo = (id: string, content: string, status: Todo['status']): Todo => ({ content, id, status })

  it('draws only the newest list as its card; older ones are steps saying what changed', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.toolStart({ args: { todos: [{ content: 'Plan', id: '1', status: 'in_progress' }, { content: 'Build', id: '2', status: 'pending' }] }, name: 'todo_list', tool_id: 'c1' }, 1)
    t.toolStart({ args: { command: 'ls' }, name: 'terminal', tool_id: 'c2' }, 2)
    t.toolStart({ args: { merge: true, todos: [{ id: '1', status: 'completed' }, { id: '2', status: 'in_progress' }] }, name: 'todo_list', tool_id: 'c3' }, 3)
    t.toolStart({ args: { command: 'pwd' }, name: 'terminal', tool_id: 'c4' }, 4)
    t.toolStart({ args: { merge: true, todos: [{ id: '2', status: 'completed' }, { content: 'Ship', id: '3', status: 'pending' }] }, name: 'todo_list', tool_id: 'c5' }, 5)

    const turn = must(t.entries.find((e): e is TurnEntry => e.kind === 'turn'))
    const ps = pieces(turn.blocks)

    // The two older lists join the commands' work group; the newest keeps its checklist card.
    expect(ps.map(p => (p.kind === 'work' ? p.items.map(i => i.id) : p.block.id))).toEqual([['c1', 'c2', 'c3', 'c4'], 'c5'])

    const first = must(ps[0])
    const steps = first.kind === 'work' ? first.items.flatMap(i => (i.kind === 'tool' && i.call.name === 'todo_list' ? [stepLabel(i.call)] : [])) : []
    expect(steps).toEqual(['Planned 2 steps', 'Plan updated: ✓ Plan, → Build'])
    expect(summarize(first.kind === 'work' ? first.items : [])).toBe('Updated the plan 2 times and ran 2 commands')

    // A part of the turn (a fold) still knows which list is the turn's newest.
    expect(pieces(turn.blocks.slice(0, 3), turn.blocks).map(p => p.kind)).toEqual(['work'])
  })

  it('words a plan change as t3code does, each item marked with its new state', () => {
    const before = [todo('1', 'Plan', 'in_progress'), todo('2', 'Build', 'pending'), todo('3', 'Test', 'pending')]
    const after = [todo('1', 'Plan', 'completed'), todo('2', 'Build', 'cancelled'), todo('3', 'Test', 'pending'), todo('4', 'Ship', 'pending')]

    expect(planStep(before, after)).toBe('Plan updated: ✓ Plan, ✗ Build, + Ship')
    expect(planStep(before, before)).toBe('Plan updated')
    expect(planStep(undefined, after)).toBe('Planned 4 steps')
    expect(planStep(before, undefined)).toBe('Plan updated')
  })

  it('reads the change of a resumed list from the call before it', () => {
    const t = new Transcript()
    t.load([
      { role: 'user', text: 'go', timestamp: 1 },
      { args: { todos: [{ content: 'Plan', id: '1', status: 'in_progress' }] }, name: 'todo_list', role: 'tool', tool_call_id: 'c1' },
      { args: { merge: true, todos: [{ id: '1', status: 'completed' }] }, name: 'todo_list', role: 'tool', tool_call_id: 'c2' }
    ])

    const turn = must(t.entries.find((e): e is TurnEntry => e.kind === 'turn'))
    const calls = turn.blocks.flatMap(b => (b.kind === 'tool' ? [b.call] : []))
    expect(calls.map(stepLabel)).toEqual(['Planned 1 step', 'Plan updated: ✓ Plan'])
    expect(pieces(turn.blocks).map(p => p.kind)).toEqual(['work', 'block'])
  })
})

describe('foldOf', () => {
  it('folds everything but the answer behind how long the turn worked', () => {
    const fold = foldOf(turn([think('k'), text('note'), tool('a', call('terminal', { command: 'ls' })), text('answer')]))

    expect(fold?.label).toBe('Worked for 54s')
    expect([...(fold?.hidden ?? [])]).toEqual(['k', 'note', 'a'])
  })

  it('does not fold a running, failed or interrupted turn, or one with nothing to hide', () => {
    const blocks = [tool('a', call('terminal')), text('answer')]

    expect(foldOf(turn(blocks, { end: { status: 'live' } }))).toBeUndefined()
    expect(foldOf(turn(blocks, { end: { endedAt: 54_000, status: 'error' } }))).toBeUndefined()
    expect(foldOf(turn(blocks, { end: { endedAt: 54_000, status: 'interrupted' } }))).toBeUndefined()
    expect(foldOf(turn([text('answer')]))).toBeUndefined()
  })

  it('keeps a background process and a delegation with running agents in view', () => {
    const bg = tool('bg', call('terminal', { background: true, command: 'sleep 9' }))
    const agents = tool('d', call('delegate_task', {}, { subagents: [{ calls: 0, goal: 'g', id: 'x', index: 0, key: subagentKey('x'), startedAt: 0, status: 'running', tokens: 0, toolCount: 0 }] }))

    expect([...(foldOf(turn([bg, agents, tool('a', call('terminal')), text('answer')]))?.hidden ?? [])]).toEqual(['a'])
  })
})

describe('parts', () => {
  const steer = (id: string, at: number): Block => ({ at, id: entryId(id), kind: 'steer', text: 'also check the tests' })

  it('keeps a steer in view and folds each stretch around it by its own time', () => {
    const t = turn([tool('a', call('terminal')), steer('s', 20_000), tool('b', call('terminal')), text('answer')])

    expect(parts(t).map(p => (p.kind === 'fold' ? `${p.label}: ${p.blocks.map(b => b.id)}` : p.blocks.map(b => b.id).join()))).toEqual([
      'Worked for 20s: a',
      's',
      'Worked for 34s: b',
      'answer'
    ])
  })

  it('shows a background card after its stretch fold, not between two folds', () => {
    const bg = tool('bg', call('terminal', { background: true, command: 'sleep 9' }))
    const t = turn([tool('a', call('terminal')), bg, tool('b', call('terminal')), text('answer')])

    expect(parts(t).map(p => p.kind + ':' + p.blocks.map(b => b.id).join())).toEqual(['fold:a,b', 'shown:bg,answer'])
  })

  it('is one shown part when the turn does not fold', () => {
    expect(parts(turn([text('answer')]))).toEqual([{ blocks: [text('answer')], kind: 'shown' }])
  })
})

describe('labels', () => {
  it('names the running program, without a shell wrapper', () => {
    const running = (command: string) => tool('a', call('terminal', { command }, { outcome: { kind: 'running' } }))

    expect(liveLabel(running('ls -la && git log'))).toBe('Running ls')
    expect(liveLabel(running("bash -lc 'npm test'"))).toBe('Running npm')
    expect(liveLabel(tool('a', call('terminal', { command: 'ls' }, { outcome: { duration: 0, kind: 'error' } })))).toBe('Failed ls')
  })

  it('keeps the live step in the present tense while the turn works on, as t3code does', () => {
    const done = (c: ToolCall) => tool('a', c)

    expect(liveLabel(done(call('terminal', { command: 'sed -n 1p a' })), true)).toBe('Running sed')
    expect(liveLabel(done(call('terminal', { command: 'sed -n 1p a' })))).toBe('Ran sed')
    expect(liveLabel(done(call('read_file', { path: 'a.ts' })), true)).toBe('Reading a.ts')
    expect(liveLabel(done(call('terminal', { command: 'x' }, { outcome: { duration: 0, kind: 'error' } })), true)).toBe('Failed x')
    expect(presentTense('Searched tools for x')).toBe('Searching tools for x')
  })

  it('names skills and tool lookups in words', () => {
    expect(stepLabel(call('skill_view', { name: 'composio' }))).toBe('Read skill composio')
    expect(stepLabel(call('tool_describe', { names: ['connectors__granola_mcp__LIST_MEETINGS', 'cronjob_manage'] }))).toBe(
      'Read how to call Granola · list meetings, cronjob manage'
    )
  })

  it('shows a command as its text on one line', () => {
    expect(stepLabel(call('terminal', { command: "sh -c 'cat a\n  | head'" }))).toBe('cat a | head')
  })

  it('says what a search looked for and where', () => {
    expect(stepLabel(call('search_files', { path: 'lab', pattern: 'def ' }))).toBe('Searched def  in lab')
    expect(stepLabel(call('search_files', { path: '.', pattern: '*.md', target: 'files' }))).toBe('Searched files *.md')
  })

  it('flattens a thought to one plain line', () => {
    expect(thoughtLine('**Planning**\n\nRead the `spec` and [docs](x).')).toBe('Planning Read the spec and docs.')
  })

  it('puts a reference answer’s label before its line', () => {
    expect(thoughtTitle({ label: 'Reference 1/2 · gpt-5', text: '**Use** SQLite.' })).toBe('Reference 1/2 · gpt-5: Use SQLite.')
    expect(thoughtTitle({ label: 'Reference · gpt-5', text: '' })).toBe('Reference · gpt-5')
    expect(thoughtTitle({ text: 'Planning.' })).toBe('Planning.')
  })

  it('formats durations as t3code does', () => {
    expect([820, 4_300, 42_000, 62_000, 3_725_000].map(durationCompact)).toEqual(['820ms', '4.3s', '42s', '1m 2s', '1h 2m 5s'])
  })
})

describe('busy labels', () => {
  it('names the running call as its step reads, not by its wire name', () => {
    const running: Partial<ToolCall> = { outcome: { kind: 'running' } }
    expect(busyLabel(call('read_file', { path: '/x/a.ts' }, running))).toBe('Reading /x/a.ts…')
    expect(busyLabel(call('terminal', { command: 'ls -la' }, running))).toBe('Running ls…')
    expect(busyLabel(call('connectors__linear__LINEAR_CREATE_ISSUE', {}, running))).toMatch(/^Linear · .*issue.*…$/i)
  })

  it('names a call the model is still writing', () => {
    expect(preparingLabel('connectors__linear__LINEAR_CREATE_ISSUE')).toMatch(/^Preparing Linear · .*issue.*…$/i)
    expect(preparingLabel('read_file')).toBe('Preparing read file…')
  })
})
