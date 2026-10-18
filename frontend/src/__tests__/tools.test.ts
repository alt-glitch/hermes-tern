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

  it('draws a one-agent delegation as its agent row alone, with no pills and no brief', () => {
    const args = { context: 'Long brief for the agent', goal: 'Audit the repo' }
    const result = { delegation_id: 'd1', mode: 'background', status: 'dispatched' }
    const live = tree(toolNode(call('delegate_task', args, { result, status: 'running' }), 0))
    expect([live.k, live.p?.name, live.p?.task, live.p?.status, live.p?.agent, live.p?.badges]).toEqual([
      'agent',
      'Background agent',
      'Audit the repo',
      'pending',
      undefined,
      undefined
    ])
    expect(JSON.stringify(live)).not.toContain('Long brief')

    const agent = { calls: 1, goal: 'Audit the repo', id: 'sa-1', index: 0, startedAt: 0, status: 'running' as const, tokens: 0, toolCount: 2 }
    const running = tree(toolNode(call('delegate_task', args, { result, status: 'done', subagents: [agent] }), 5))
    expect([running.k, running.p?.key, running.p?.name, running.p?.role]).toEqual(['agent', 'c1', 'Background agent', 'hermes.task.solo'])

    // A resumed one: its result's report folds inside the row.
    const done = tree(toolNode(call('delegate_task', { goal: 'Audit the repo' }, { result: { results: [{ status: 'ok', summary: 'all clear' }] } }), 0))
    expect([done.p?.name, done.p?.status, done.p?.collapsed]).toEqual(['Agent', 'done', true])
    expect(JSON.stringify(done)).toContain('all clear')

    // A dispatch that failed keeps the Task card, which says why.
    expect(tree(toolNode(call('delegate_task', args, { result: { error: 'no model' }, status: 'error' }), 0)).k).toBe('tool')
  })

  it("folds a several-agent delegation's shared brief, and its rows carry no type pill", () => {
    const args = { context: 'Shared notes', tasks: [{ goal: 'g1' }, { goal: 'g2' }] }
    const n = tree(toolNode(call('delegate_task', args), 0))
    const rows = (n.c ?? []).filter(c => c.k === 'agent')
    expect(rows.map(r => r.p?.agent)).toEqual([undefined, undefined])
    const brief = (n.c ?? []).find(c => c.k === 'section')
    expect([brief?.p?.head, brief?.p?.collapsed]).toEqual(['Shared brief', true])
  })

  it('draws the legacy `todo` tool as the checklist', () => {
    const todos = [{ content: 'Plan', id: '1', status: 'completed' as const }]
    const n = tree(toolNode(call('todo', { todos }, { todos }), 0))
    expect([n.p?.name, n.p?.title, n.p?.target]).toEqual(['todo', 'Todo', '1/1'])
  })
})
