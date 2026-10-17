import { describe, expect, it } from 'vitest'

import type { Block, ToolCall } from '../model.js'
import { groupRuns, summarize } from '../view/toolRuns.js'

const call = (name: string, id = name): ToolCall => ({
  args: {},
  argsText: '',
  context: '',
  id,
  name,
  startedAt: 0,
  status: 'done'
})

const tool = (name: string, id: string): Block => ({ call: call(name, id), id, kind: 'tool' })
const text = (id: string): Block => ({ id, kind: 'text', text: 'x' })
const think = (id: string): Block => ({ id, kind: 'thinking', startedAt: 0, text: 'hm' })

describe('summarize', () => {
  it('counts calls by kind in first-use order', () => {
    expect(summarize([call('terminal'), call('read_file'), call('terminal'), call('read_file'), call('patch')])).toBe(
      'Ran 2 commands, read 2 files and edited 1 file'
    )
  })

  it('names tools it has no phrase for', () => {
    expect(summarize([call('mcp_linear')])).toBe('Made 1 mcp_linear call')
  })

  it('says once and twice for searches', () => {
    expect(summarize([call('terminal'), call('search_files'), call('web_search'), call('web_search')])).toBe(
      'Ran 1 command, searched once and searched twice on the web'
    )
  })
})

describe('groupRuns', () => {
  it('folds two or more calls, keeps reasoning between them, and leaves Task cards alone', () => {
    const blocks = [
      tool('terminal', 'a'),
      think('k'),
      tool('read_file', 'b'),
      think('k2'),
      text('t'),
      tool('delegate_task', 'd'),
      tool('terminal', 'c')
    ]

    const out = groupRuns(blocks)

    expect(out.map(b => (Array.isArray(b) ? b.map(x => x.id) : b.id))).toEqual([['a', 'k', 'b'], 'k2', 't', 'd', 'c'])
  })
})

describe('turns Hermes starts by itself', () => {
  it('marks a turn that follows a turn, and says when subagents finished', async () => {
    const { Transcript } = await import('../transcript.js')
    const t = new Transcript()

    t.load([
      { content: 'delegate', role: 'user', timestamp: 1 },
      { content: '', role: 'assistant', timestamp: 2 },
      { args: { tasks: [] }, name: 'delegate_task', role: 'tool', timestamp: 2, tool_call_id: 'c1' },
      { content: '{"status": "dispatched", "mode": "background"}', name: 'delegate_task', role: 'tool', timestamp: 3, tool_call_id: 'c1' },
      { content: 'Dispatched.', role: 'assistant', timestamp: 4 },
      { content: '[ASYNC DELEGATION BATCH COMPLETE — deleg_1] results', role: 'user', timestamp: 5 },
      { content: 'All three finished.', role: 'assistant', timestamp: 6 }
    ] as never)

    const kinds = t.entries.map(e => e.kind)
    const turns = t.entries.filter(e => e.kind === 'turn')

    expect(kinds).not.toContain('notice')
    expect(t.entries.filter(e => e.kind === 'user')).toHaveLength(1)
    expect(turns.map(e => e.continued)).toEqual([undefined, 'Subagents finished'])
  })
})
