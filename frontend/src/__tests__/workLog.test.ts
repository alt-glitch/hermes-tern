import { describe, expect, it } from 'vitest'

import type { Block, ToolCall, TurnEntry } from '../model.js'
import { foldOf, formatDuration, liveLabel, parts, pieces, presentTense, stepLabel, summarize, thoughtLine, type WorkItem } from '../workLog.js'

const call = (name: string, args: Record<string, unknown> = {}, more: Partial<ToolCall> = {}): ToolCall => ({
  args,
  argsText: '',
  context: '',
  id: `${name}-${JSON.stringify(args)}`,
  name,
  startedAt: 0,
  status: 'done',
  ...more
})

const tool = (id: string, c: ToolCall): Extract<Block, { kind: 'tool' }> => ({ call: c, id, kind: 'tool' })
const text = (id: string, t = 'x'): Block => ({ id, kind: 'text', text: t })
const think = (id: string, t = 'hm'): Extract<Block, { kind: 'thinking' }> => ({ endedAt: 1, id, kind: 'thinking', startedAt: 0, text: t })

const turn = (blocks: Block[], more: Partial<TurnEntry> = {}): TurnEntry => ({
  blocks,
  endedAt: 54_000,
  id: 't',
  kind: 'turn',
  rev: 0,
  startedAt: 0,
  status: 'done',
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

describe('foldOf', () => {
  it('folds everything but the answer behind how long the turn worked', () => {
    const fold = foldOf(turn([think('k'), text('note'), tool('a', call('terminal', { command: 'ls' })), text('answer')]))

    expect(fold?.label).toBe('Worked for 54s')
    expect([...(fold?.hidden ?? [])]).toEqual(['k', 'note', 'a'])
  })

  it('does not fold a running, failed or interrupted turn, or one with nothing to hide', () => {
    const blocks = [tool('a', call('terminal')), text('answer')]

    expect(foldOf(turn(blocks, { status: 'live' }))).toBeUndefined()
    expect(foldOf(turn(blocks, { status: 'error' }))).toBeUndefined()
    expect(foldOf(turn(blocks, { status: 'interrupted' }))).toBeUndefined()
    expect(foldOf(turn([text('answer')]))).toBeUndefined()
  })

  it('keeps a background process and a delegation with running agents in view', () => {
    const bg = tool('bg', call('terminal', { background: true, command: 'sleep 9' }))
    const agents = tool('d', call('delegate_task', {}, { subagents: [{ calls: 0, goal: 'g', id: 'x', index: 0, startedAt: 0, status: 'running', tokens: 0, toolCount: 0 }] }))

    expect([...(foldOf(turn([bg, agents, tool('a', call('terminal')), text('answer')]))?.hidden ?? [])]).toEqual(['a'])
  })
})

describe('parts', () => {
  const steer = (id: string, at: number): Block => ({ at, id, kind: 'steer', text: 'also check the tests' })

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
    const running = (command: string) => tool('a', call('terminal', { command }, { status: 'running' }))

    expect(liveLabel(running('ls -la && git log'))).toBe('Running ls')
    expect(liveLabel(running("bash -lc 'npm test'"))).toBe('Running npm')
    expect(liveLabel(tool('a', call('terminal', { command: 'ls' }, { status: 'error' })))).toBe('Failed ls')
  })

  it('keeps the live step in the present tense while the turn works on, as t3code does', () => {
    const done = (c: ToolCall) => tool('a', c)

    expect(liveLabel(done(call('terminal', { command: 'sed -n 1p a' })), true)).toBe('Running sed')
    expect(liveLabel(done(call('terminal', { command: 'sed -n 1p a' })))).toBe('Ran sed')
    expect(liveLabel(done(call('read_file', { path: 'a.ts' })), true)).toBe('Reading a.ts')
    expect(liveLabel(done(call('terminal', { command: 'x' }, { status: 'error' })), true)).toBe('Failed x')
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

  it('formats durations as t3code does', () => {
    expect([820, 4_300, 42_000, 62_000, 3_725_000].map(formatDuration)).toEqual(['820ms', '4.3s', '42s', '1m 2s', '1h 2m 5s'])
  })
})
