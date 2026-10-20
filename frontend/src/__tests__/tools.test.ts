import type { JSX } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import type { ToolCall, TurnEntry } from '../model.js'
import { toolDetail, toolNode } from '../view/tools/shell.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { actionOf, stepLabel } from '../workLog.js'

interface Node {
  k: string
  p?: Record<string, unknown>
  c?: Node[]
}

const call = (name: string, args: Record<string, unknown>, { id = 'c1', ...more }: Omit<Partial<ToolCall>, 'id'> & { id?: string } = {}): ToolCall => ({
  args,
  argsText: '',
  context: '',
  id: toolCallId(id),
  name,
  startedAt: 0,
  outcome: { duration: 0, kind: 'done' },
  via: { kind: 'direct' },
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
    const live = tree(toolNode(call('delegate_task', args, { result, outcome: { kind: 'running' } }), 0))
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
    const running = tree(toolNode(call('delegate_task', args, { result, outcome: { duration: 0, kind: 'done' }, subagents: [agent] }), 5))
    expect([running.k, running.p?.key, running.p?.name, running.p?.role]).toEqual(['agent', 'c1', 'Background agent', 'hermes.task.solo'])

    // A resumed one: its result's report folds inside the row.
    const done = tree(toolNode(call('delegate_task', { goal: 'Audit the repo' }, { result: { results: [{ status: 'ok', summary: 'all clear' }] } }), 0))
    expect([done.p?.name, done.p?.status, done.p?.collapsed]).toEqual(['Agent', 'done', true])
    expect(JSON.stringify(done)).toContain('all clear')

    // A dispatch that failed keeps the Task card, which says why.
    expect(tree(toolNode(call('delegate_task', args, { result: { error: 'no model' }, outcome: { duration: 0, kind: 'error' } }), 0)).k).toBe('tool')
  })

  it("folds a several-agent delegation's shared brief, and its rows carry no type pill", () => {
    const args = { context: 'Shared notes', tasks: [{ goal: 'g1' }, { goal: 'g2' }] }
    const n = tree(toolNode(call('delegate_task', args), 0))
    const rows = (n.c ?? []).filter(c => c.k === 'agent')
    expect(rows.map(r => r.p?.agent)).toEqual([undefined, undefined])
    const brief = (n.c ?? []).find(c => c.k === 'section')
    expect([brief?.p?.head, brief?.p?.collapsed]).toEqual(['Shared brief', true])
  })

  it("gives a Python cell's code and output the card's width", () => {
    const n = tree(toolNode(call('execute_code', { code: 'print(1)' }, { result: { output: '1\n' } }), 0))
    const cell = n.c?.[0]?.c ?? []
    expect(cell.map(r => r.c?.[1]?.p?.grow)).toEqual([1, 1])
    expect(cell[1]?.c?.[1]?.c?.[0]?.p?.text).toBe('1')
  })

  it('draws the legacy `todo` tool as the checklist', () => {
    const todos = [{ content: 'Plan', id: '1', status: 'completed' as const }]
    const n = tree(toolNode(call('todo', { todos }, { todos }), 0))
    expect([n.p?.name, n.p?.title, n.p?.target]).toEqual(['todo', 'Todo', '1/1'])
  })
})

// WP24: a card that throws while it draws costs its own card, not the frame.
describe('a card that throws', () => {
  /** A terminal call whose args throw when the card reads them (a renderer bug's stand-in); `more` replaces its output. */
  const broken = (id: string, more: Partial<ToolCall> = { result: { output: 'still here' }, resultText: 'still here' }) =>
    call(
      'terminal',
      Object.defineProperty({}, 'command', {
        enumerable: true,
        get: () => {
          throw new Error('bad args')
        }
      }),
      { id, ...more }
    )

  it('draws the generic card instead, and is told once per tool name', async () => {
    const { onCardFault } = await import('../view/tools/faults.js')
    const told: [string, string][] = []
    onCardFault((name, error) => void told.push([name, error instanceof Error ? error.message : String(error)]))

    const first = tree(toolNode(broken('c1'), 0))
    const again = tree(toolNode(broken('c2'), 0))

    expect(first).toMatchObject({ k: 'tool', p: { name: 'terminal', title: 'Terminal' } })
    expect(JSON.stringify(first)).toContain('still here')
    expect(again.k).toBe('tool')
    expect(told).toEqual([['terminal', 'bad args']])
  })

  it("says why a failed one failed without the tool's parse, in its card and in a work group's step", async () => {
    const { noticeSink, onCardFault } = await import('../view/tools/faults.js')
    const notices: string[] = []
    onCardFault(noticeSink(text => void notices.push(text)))
    // No output: the reason goes in the head (and the step), read from the summary.
    const failed = broken('c3', { outcome: { duration: 0, kind: 'error', summary: 'boom' } })

    expect(tree(toolNode(failed, 0))).toMatchObject({ k: 'tool', p: { note: 'boom', status: 'error' } })
    expect(toolDetail(failed, 0).flatMap(n => words(tree(n)))).toEqual(['boom'])
    // The notice waits for the frame to finish.
    expect(notices).toEqual([])
    await Promise.resolve()

    expect(notices).toEqual(['The terminal card failed to draw (bad args); it shows as a plain card.'])
  })

  it("costs only its own step in a done turn's work group: the step line and icon are the generic ones", async () => {
    const { onCardFault } = await import('../view/tools/faults.js')
    const told: string[] = []
    onCardFault(name => void told.push(name))
    const blocks = [
      { call: broken('c4'), id: entryId('b1'), kind: 'tool' as const },
      { call: broken('c5'), id: entryId('b2'), kind: 'tool' as const },
      { id: entryId('b3'), kind: 'text' as const, text: 'Done.' }
    ]
    const turn: TurnEntry = { blocks, endedAt: 9, id: entryId('t'), kind: 'turn', rev: 0, startedAt: 0, status: 'done' }
    const cx: TranscriptContext = { copy: () => undefined, now: 9, welcome: { tip: '', version: '' } }

    const n = tree(entryNode(turn, 'main.t', cx))

    expect(JSON.stringify(n)).toContain('Done.')
    expect(stepLabel(broken('c6'))).toBe('Terminal')
    expect(actionOf(broken('c7'))).toBe('other')
    expect(told).toEqual(['terminal'])
  })
})
