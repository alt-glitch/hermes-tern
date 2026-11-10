import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { agentHovercard, agentWaitNode } from '../agents/tiles.js'
import { stepsOf } from '../agents/transcript.js'
import { entryId, subagentKey, toolCallId } from '../core/ids.js'
import type { Subagent, ToolCall, TurnEntry } from '../model.js'
import { toolNode } from '../view/tools/shell.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'

import { must, spanTexts, tree } from './fakes.js'

function agent(id: string, more: Partial<Subagent> = {}): Subagent {
  return { calls: 0, goal: `Goal ${id}`, id, index: 0, key: subagentKey(id), name: `Worker ${id}`, startedAt: 1000, status: 'running', tokens: 0, toolCount: 0, ...more }
}

const nodes = (n: NodeJson): NodeJson[] => [n, ...(n.c ?? []).flatMap(nodes)]
const role = (n: NodeJson, value: string): NodeJson[] => nodes(n).filter(x => x.p?.['role'] === value)
const words = (n: NodeJson): string[] => nodes(n).flatMap(x => [...spanTexts(x.p?.['spans']), ...(typeof x.p?.['text'] === 'string' ? [x.p['text']] : [])])
const wait = (agents: readonly Subagent[], now = 6000) => tree(must(agentWaitNode(agents, now)))
/** The click a tile sends: on the native button the tile sits in (view/ui/button.tsx). */
const tileActions = (n: NodeJson): unknown[] =>
  nodes(n).filter(x => x.k === 'el' && x.p?.['tag'] === 'button' && x.c?.[0]?.p?.['role'] === 'omp.job.tile').map(x => x.p?.['actions'])

function delegation(agents: Subagent[]): ToolCall {
  return { args: { tasks: agents.map(a => ({ goal: a.goal })) }, argsText: '', context: '', id: toolCallId('d1'), name: 'delegate_task', outcome: { duration: 0, kind: 'done' }, result: { delegation_id: 'deleg_1', mode: 'background', status: 'dispatched' }, startedAt: 0, subagents: agents, via: { kind: 'direct' } }
}

describe('agent wait tiles', () => {
  it('shows the name, status dot, native spinner and true age, current tool and progress', () => {
    const n = wait([agent('a', {
      tool: 'read_file', toolPreview: 'Inspecting source',
      steps: stepsOf([{ row_kind: 'message', role: 'assistant', timestamp: 1, text: 'Found the entry point.' }])
    })])

    expect(role(n, 'omp.job.tiles')).toHaveLength(1)
    const tile = must(role(n, 'omp.job.tile')[0])
    expect(words(tile).join(' ')).toContain('Worker a')
    expect(tileActions(n)[0]).toMatchObject({ click: 'open-agent=a' })
    expect(words(tile).join(' ')).toContain('read_file')
    expect(words(tile).join(' ')).toContain('Found the entry point.')
    expect(nodes(tile).some(x => x.k === 'spinner')).toBe(true)
    expect(nodes(tile).some(x => x.k === 'elapsed' && x.p?.['age'] === 5000)).toBe(true)
    expect(nodes(tile).some(x => x.k === 'text' && spanTexts(x.p?.['spans']).some(t => t.includes('●')))).toBe(true)
  })

  it('uses tool preview when no transcript steps are available and queued tiles remain visible', () => {
    const n = wait([agent('a', { tool: 'terminal', toolPreview: 'Reading   package\n scripts' }), agent('q', { status: 'queued' })])
    expect(role(n, 'omp.job.tile')).toHaveLength(2)
    expect(words(n).join(' ')).toContain('Reading package scripts')
    expect(words(n)).toContain('Worker q')
    expect(role(n, 'omp.job.tile').some(x => String(x.p?.['title']).toLowerCase().includes('queued'))).toBe(true)
  })

  it('limits active tiles to four and routes the precise overflow count to the agents hub', () => {
    const n = wait([agent('done', { status: 'done' }), ...Array.from({ length: 7 }, (_, i) => agent(`${i}`, { index: i, status: i === 6 ? 'queued' : 'running' }))])
    expect(role(n, 'omp.job.tile')).toHaveLength(4)
    expect(words(n).join(' ')).toContain('+3 more agents · /agents')
    expect(tileActions(n)).toEqual(['0', '1', '2', '3'].map(id => ({ click: `open-agent=${id}`, menu: [`open-agent=${id}`] })))
    expect(words(n).join(' ')).not.toContain('Worker done')
    expect(nodes(n).map(x => x.p?.['actions'])).toContainEqual({ click: 'open-agents=all' })
  })

  it('removes running and queued children as they settle, including failures and cancellation', () => {
    const children = [agent('a'), agent('q', { status: 'queued' })]
    expect(role(wait(children), 'omp.job.tile')).toHaveLength(2)
    must(children[0]).status = 'done'
    expect(tileActions(wait(children))).toEqual([{ click: 'open-agent=q', menu: ['open-agent=q'] }])
    must(children[1]).status = 'running'
    expect(tileActions(wait(children))).toEqual([{ click: 'open-agent=q', menu: ['open-agent=q'] }])
    must(children[1]).status = 'done'
    expect(agentWaitNode(children, 9000)).toBeUndefined()
    expect(agentWaitNode([agent('f', { status: 'failed' }), agent('c', { status: 'cancelled' })], 9000)).toBeUndefined()
    expect(agentWaitNode([], 9000)).toBeUndefined()
  })

  it('shows only the latest two assistant/tool lines in chronological order, never private thoughts or results', () => {
    const n = wait([agent('a', { steps: stepsOf([
      { row_kind: 'message', role: 'user', timestamp: 1, text: 'hidden kickoff' },
      { row_kind: 'message', role: 'assistant', timestamp: 2, text: 'old progress' },
      { row_kind: 'message', role: 'assistant', timestamp: 3, text: '  Checking\n the\t model  ' },
      { row_kind: 'message', role: 'tool', timestamp: 4, name: 'read_file', context: '{"path":"model.ts","i":"Reading   model fields"}', text: 'hidden result' },
      { row_kind: 'message', role: 'assistant', timestamp: 5, reasoning: 'hidden thought', text: '' },
      { row_kind: 'message', role: 'system', timestamp: 6, text: 'hidden note' }
    ]) })])
    const text = words(n).join(' ')
    expect(role(n, 'omp.job.tile.note').map(x => words(x).join(''))).toEqual(['Checking the model', 'Reading model fields'])
    expect(text).toContain('Checking the model')
    expect(text).toContain('Reading model fields')
    expect(text.indexOf('Checking the model')).toBeLessThan(text.indexOf('Reading model fields'))
    for (const excluded of ['old progress', 'hidden kickoff', 'hidden thought', 'hidden result', 'hidden note']) {
      expect(text).not.toContain(excluded)
    }
  })

  it('collapses adjacent duplicate progress and falls back to raw tool args when no intent is present', () => {
    const n = wait([agent('a', { tool: 'terminal', toolPreview: 'Last update', steps: stepsOf([
      { row_kind: 'message', role: 'assistant', timestamp: 1, text: 'First update' },
      { row_kind: 'message', role: 'tool', timestamp: 2, name: 'terminal', context: 'git   diff\n --stat', text: 'hidden result' },
      { row_kind: 'message', role: 'assistant', timestamp: 3, text: 'Last  update' },
      { row_kind: 'message', role: 'assistant', timestamp: 4, text: 'Last update' }
    ]) })])
    expect(role(n, 'omp.job.tile.note').map(x => words(x).join(''))).toEqual(['git diff --stat', 'Last update'])
  })

  it('reuses unchanged wait nodes without timer ticks and refreshes native age after progress changes', () => {
    const child = agent('a', { tool: 'terminal', toolPreview: 'Inspecting tests' })
    const first = must(agentWaitNode([child], 6000))
    expect(agentWaitNode([child], 12000)).toBe(first)
    child.toolPreview = 'Reading assertions'
    const updated = must(agentWaitNode([child], 12000))
    expect(updated).not.toBe(first)
    expect(nodes(tree(updated)).find(x => x.k === 'elapsed')?.p?.['age']).toBe(11000)
    expect(agentWaitNode([child], 15000)).toBe(updated)
    expect(agentHovercard([child], 12000)).toEqual(tree(must(agentWaitNode([child], 12000, 'agent-hover'))))
  })

  it('caps each progress line at 160 characters including the ellipsis and never wraps it', () => {
    const n = wait([agent('a', { steps: stepsOf([{ row_kind: 'message', role: 'assistant', timestamp: 1, text: `  ${'x'.repeat(170)}\n tail  ` }]) })])
    const line = must(nodes(n).find(x => words(x).join('').startsWith('x') && x.k === 'text'))
    expect(words(line).join('')).toBe(`${'x'.repeat(159)}…`)
    expect(line.p).toMatchObject({ truncate: 'end', wrap: 'none' })
  })

  it('uses the frame for a solo active delegate and settled agent rows when all children finish', () => {
    const child = agent('a')
    const call = delegation([child])
    expect(role(tree(toolNode(call, 6000)), 'omp.job.tiles')).toHaveLength(1)
    child.status = 'done'
    const settled = tree(toolNode(call, 9000))
    expect(role(settled, 'omp.job.tiles')).toHaveLength(0)
    expect(nodes(settled).some(x => x.k === 'agent' && x.p?.['status'] === 'done')).toBe(true)
  })

  it('does not rebuild a transcript entry just to tick age, but sends true age on a revision rebuild', () => {
    const child = agent('a', { tool: 'terminal' })
    const call = delegation([child])
    const turn: TurnEntry = { blocks: [{ call, id: call.id, kind: 'tool' }], end: { status: 'live' }, id: entryId('t'), kind: 'turn', rev: 0, startedAt: 0 }
    const cx: TranscriptContext = { copy: () => undefined, now: 6000, welcome: { version: '' } }
    const first = entryNode(turn, 'main.t', cx)
    expect(nodes(tree(first)).some(x => x.k === 'elapsed' && x.p?.['age'] === 5000)).toBe(true)
    cx.now = 12000
    expect(entryNode(turn, 'main.t', cx)).toBe(first)
    child.toolPreview = 'New progress'
    turn.rev++
    const rebuilt = entryNode(turn, 'main.t', cx)
    expect(rebuilt).not.toBe(first)
    expect(nodes(tree(rebuilt)).some(x => x.k === 'elapsed' && x.p?.['age'] === 11000)).toBe(true)
    cx.now = 15000
    expect(entryNode(turn, 'main.t', cx)).toBe(rebuilt)
  })
})
