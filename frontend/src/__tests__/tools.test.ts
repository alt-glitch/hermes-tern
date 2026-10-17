import type { JSX } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import type { ToolCall } from '../model.js'
import { toolNode } from '../view/tools.js'

interface Node {
  k: string
  p?: Record<string, unknown>
  c?: Node[]
}

const call = (name: string, args: Record<string, unknown>, more: Partial<ToolCall> = {}): ToolCall => ({
  args,
  argsText: '',
  context: '',
  id: 'c1',
  name,
  startedAt: 0,
  status: 'done',
  ...more
})

/** The node as it goes on the wire, `{k, p?, c?}`. */
const tree = (n: JSX.Element): Node => JSON.parse(JSON.stringify(n)) as Node

/** Every span's text under `n`, in order. */
function words(n: Node): string[] {
  const spans = Array.isArray(n.p?.spans) ? (n.p.spans as { t: string }[]).map(s => s.t) : []

  return [...spans, ...(n.c ?? []).flatMap(words)]
}

describe('tool cards', () => {
  it('leaves a resumed clarify call without a verdict: history drops its answer', () => {
    const n = tree(toolNode(call('clarify', { choices: ['a', 'b'], question: 'Pick?' }), 0))
    expect(words(n)).not.toContain('No answer')
  })

  it('still says a known missing or skipped answer', () => {
    const args = { questions: [{ question: 'One?' }, { question: 'Two?' }] }
    const result = { responses: [{ status: 'unanswered', user_response: null }, { status: 'skipped', user_response: null }] }
    const n = tree(toolNode(call('clarify', args, { result }), 0))
    expect(words(n)).toEqual(expect.arrayContaining(['No answer', 'Skipped']))
  })

  it('lists a settled delegation’s goals when no subagent events came (a resumed session)', () => {
    const args = { tasks: [{ goal: 'g1' }, { goal: 'g2' }] }
    const resumed = tree(toolNode(call('delegate_task', args), 0))
    expect((resumed.c ?? []).filter(c => c.k === 'agent').map(r => [r.p?.task, r.p?.status])).toEqual([
      ['g1', 'idle'],
      ['g2', 'idle']
    ])

    const result = { results: [{ status: 'ok', summary: 'did g1' }, { status: 'timeout' }] }
    const settled = (tree(toolNode(call('delegate_task', args, { result }), 0)).c ?? []).filter(c => c.k === 'agent')
    expect(settled.map(r => [r.p?.task, r.p?.status])).toEqual([
      ['g1', 'done'],
      ['g2', 'failed']
    ])
    expect(JSON.stringify(settled[0])).toContain('did g1')
  })

  it('draws the legacy `todo` tool as the checklist', () => {
    const todos = [{ content: 'Plan', id: '1', status: 'completed' as const }]
    const n = tree(toolNode(call('todo', { todos }, { todos }), 0))
    expect([n.p?.name, n.p?.title, n.p?.target]).toEqual(['todo', 'Todo', '1/1'])
  })
})
