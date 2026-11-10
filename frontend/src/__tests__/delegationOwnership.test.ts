import type { SubagentEventPayload } from '@hermes/shared/gateway-events'
import { describe, expect, it, vi } from 'vitest'

import { attachRow, ownersOf } from '../agents/rows.js'
import { Agents } from '../agents/store.js'
import { liveSessionId } from '../core/ids.js'
import type { ToolCall } from '../model.js'
import { routeEvent } from '../session/flow.js'
import { Transcript } from '../transcript/store.js'

import { FakeGateway, must } from './fakes.js'

/** The real transcript reducer supplies both calls and their dispatch results. */
function dispatched(transcript: Transcript, tool: string, delegation: string, at: number): ToolCall {
  transcript.messageStart(at)
  transcript.toolStart({ args: { tasks: [{ goal: tool }] }, name: 'delegate_task', tool_id: tool }, at + 1)
  transcript.toolComplete({
    name: 'delegate_task',
    result: { delegation_id: delegation, mode: 'background', status: 'dispatched' },
    tool_id: tool
  }, at + 2)
  transcript.complete({ status: 'complete' }, at + 3)

  return must(transcript.delegations().find(call => call.id === tool))
}

function payload(subagentId: string, delegationId?: string): SubagentEventPayload {
  return {
    goal: subagentId,
    subagent_id: subagentId,
    task_count: 1,
    task_index: 0,
    ...(delegationId === undefined ? {} : { delegation_id: delegationId })
  }
}

function rig() {
  const transcript = new Transcript()
  const ended = vi.fn()
  const changed = vi.fn()
  let session = liveSessionId('session-a')
  const agents = new Agents({
    agentEnded: ended,
    changed,
    gw: new FakeGateway().client,
    get sid() {
      return session
    },
    transcript
  })

  return {
    agents,
    changed,
    ended,
    setSession(id: string) {
      session = liveSessionId(id)
      agents.adopt(session)
    },
    transcript
  }
}

describe('delegation ownership (gateway events → Agents → transcript)', () => {
  it('isolates overlapping A/B delegations even when B starts first', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)

    h.agents.apply('subagent.start', payload('worker-b', 'group-b'), 20)
    h.agents.apply('subagent.start', payload('worker-a', 'group-a'), 21)
    h.agents.apply('subagent.tool', { ...payload('worker-a', 'group-a'), tool_name: 'terminal' }, 22)

    expect(a.subagents).toMatchObject([{ delegationId: 'group-a', id: 'worker-a', status: 'running', tool: 'terminal' }])
    expect(b.subagents).toMatchObject([{ delegationId: 'group-b', id: 'worker-b', status: 'running' }])
    h.agents.dispose()
  })

  it('binds a distinct nested batch under A while root batch B overlaps', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)
    h.agents.apply('subagent.start', { ...payload('root-a', 'group-a'), depth: 0 }, 20)
    h.agents.apply('subagent.start', { ...payload('root-b', 'group-b'), depth: 0 }, 21)
    const nested = { ...payload('nested-c', 'group-c'), parent_id: 'root-a', depth: 1 }
    const revisions = h.transcript.entries.filter(e => e.kind === 'turn').map(t => t.rev)

    // Before any registry/list result mentions group-c, parent ancestry proves A.
    h.agents.apply('subagent.spawn_requested', nested, 22)
    expect(a.subagents?.find(agent => agent.id === 'nested-c')).toMatchObject({
      delegationId: 'group-c', depth: 1, parentId: 'root-a', status: 'queued'
    })
    expect(b.subagents?.map(agent => agent.id)).toEqual(['root-b'])

    h.agents.apply('subagent.start', nested, 23)
    h.agents.apply('subagent.tool', { ...nested, tool_name: 'terminal' }, 24)
    h.agents.apply('subagent.progress', { ...payload('nested-c', 'group-c'), status: 'running', tool_count: 3 }, 25)
    h.agents.apply('subagent.complete', {
      ...payload('nested-c', 'group-c'), status: 'completed', summary: 'nested finished'
    }, 26)

    expect(a.subagents?.find(agent => agent.id === 'nested-c')).toMatchObject({
      delegationId: 'group-c', depth: 1, parentId: 'root-a', status: 'done',
      summary: 'nested finished', toolCount: 3
    })
    expect(b.subagents).toMatchObject([{ delegationId: 'group-b', id: 'root-b', status: 'running' }])
    const after = h.transcript.entries.filter(e => e.kind === 'turn').map(t => t.rev)
    expect(after[0]).toBeGreaterThan(revisions[0] ?? 0)
    expect(after[1]).toBe(revisions[1])
    h.agents.dispose()
  })

  it('accepts a nested tool before start, retains its batch through id-less progress, and anchors a grandchild', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)
    h.agents.apply('subagent.start', { ...payload('root-a', 'group-a'), depth: 0 }, 20)
    h.agents.apply('subagent.start', { ...payload('root-b', 'group-b'), depth: 0 }, 21)

    // Out-of-order delivery still provides a complete first-event parent chain.
    h.agents.apply('subagent.tool', {
      ...payload('nested-c', 'group-c'), parent_id: 'root-a', depth: 1, tool_name: 'read_file'
    }, 22)
    h.agents.apply('subagent.progress', { ...payload('nested-c'), tool_count: 2 }, 23)
    expect(a.subagents?.find(agent => agent.id === 'nested-c')).toMatchObject({
      delegationId: 'group-c', depth: 1, parentId: 'root-a', tool: 'read_file', toolCount: 2
    })

    h.agents.apply('subagent.start', payload('nested-c', 'group-c'), 24)
    h.agents.apply('subagent.tool', {
      ...payload('nested-d', 'group-d'), parent_id: 'nested-c', depth: 2, tool_name: 'terminal'
    }, 25)
    h.agents.apply('subagent.complete', { ...payload('nested-d', 'group-d'), status: 'completed' }, 26)
    h.agents.apply('subagent.complete', { ...payload('nested-c', 'group-c'), status: 'completed' }, 27)

    expect(a.subagents?.find(agent => agent.id === 'nested-d')).toMatchObject({
      delegationId: 'group-d', depth: 2, parentId: 'nested-c', status: 'done'
    })
    expect(a.subagents?.find(agent => agent.id === 'nested-c')).toMatchObject({
      delegationId: 'group-c', depth: 1, parentId: 'root-a', status: 'done'
    })
    expect(b.subagents).toMatchObject([{ id: 'root-b', status: 'running' }])
    h.agents.dispose()
  })

  it('binds a later explicit nested batch to an id-less child with the same proven parent', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)
    h.agents.apply('subagent.start', { ...payload('root-a', 'group-a'), depth: 0 }, 20)
    h.agents.apply('subagent.start', { ...payload('root-b', 'group-b'), depth: 0 }, 21)

    // The spawn may be relayed before the child's own delegation_id is stamped.
    h.agents.apply('subagent.spawn_requested', {
      ...payload('nested-c'), parent_id: 'root-a', depth: 1
    }, 22)
    expect(a.subagents?.find(agent => agent.id === 'nested-c')).toMatchObject({
      id: 'nested-c', depth: 1, parentId: 'root-a'
    })
    expect(a.subagents?.find(agent => agent.id === 'nested-c')?.delegationId).toBeUndefined()

    const beforeA = JSON.stringify(a.subagents)
    const beforeB = JSON.stringify(b.subagents)
    const revisions = h.transcript.entries.filter(e => e.kind === 'turn').map(t => t.rev)
    h.agents.apply('subagent.tool', {
      ...payload('nested-c', 'group-c'), parent_id: 'root-b', depth: 1, tool_name: 'foreign'
    }, 23)
    expect(JSON.stringify(a.subagents)).toBe(beforeA)
    expect(JSON.stringify(b.subagents)).toBe(beforeB)
    expect(h.transcript.entries.filter(e => e.kind === 'turn').map(t => t.rev)).toEqual(revisions)

    h.agents.apply('subagent.tool', {
      ...payload('nested-c', 'group-c'), parent_id: 'root-a', depth: 1, tool_name: 'terminal'
    }, 24)
    h.agents.apply('subagent.progress', { ...payload('nested-c'), tool_count: 3 }, 25)
    h.agents.apply('subagent.complete', { ...payload('nested-c', 'group-c'), status: 'completed' }, 26)
    expect(a.subagents?.find(agent => agent.id === 'nested-c')).toMatchObject({
      delegationId: 'group-c', depth: 1, parentId: 'root-a', status: 'done', toolCount: 3
    })
    expect(b.subagents).toMatchObject([{ id: 'root-b', status: 'running' }])
    h.agents.dispose()
  })

  it('inherits an established nested batch parent for a later sibling event with no parent hint', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)
    h.agents.apply('subagent.start', { ...payload('root-a', 'group-a'), depth: 0 }, 20)
    h.agents.apply('subagent.start', { ...payload('root-b', 'group-b'), depth: 0 }, 21)
    h.agents.apply('subagent.start', {
      ...payload('nested-c0', 'group-c'), parent_id: 'root-a', depth: 1
    }, 22)
    h.agents.apply('subagent.start', { ...payload('nested-c1', 'group-c'), task_index: 0 }, 23)

    expect(a.subagents?.find(agent => agent.id === 'nested-c1')).toMatchObject({
      delegationId: 'group-c', depth: 1, parentId: 'root-a', status: 'running'
    })
    expect(b.subagents?.map(agent => agent.id)).toEqual(['root-b'])
    h.agents.dispose()
  })

  it('rejects new foreign batches without a unique existing parent and does not touch transcript revisions', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)
    h.agents.apply('subagent.start', { ...payload('root-a', 'group-a'), depth: 0 }, 20)
    h.agents.apply('subagent.start', { ...payload('root-b', 'group-b'), depth: 0 }, 21)
    const beforeA = JSON.stringify(a.subagents)
    const beforeB = JSON.stringify(b.subagents)
    const revisions = h.transcript.entries.filter(e => e.kind === 'turn').map(t => t.rev)

    h.agents.apply('subagent.start', payload('orphan', 'group-c'), 22)
    h.agents.apply('subagent.tool', {
      ...payload('unknown-parent', 'group-c'), parent_id: 'not-an-agent', depth: 1, tool_name: 'terminal'
    }, 23)
    h.agents.apply('subagent.start', {
      ...payload('root-b', 'group-c'), parent_id: 'root-a', depth: 1
    }, 24)
    h.agents.apply('subagent.start', {
      ...payload('root-a', 'group-c'), parent_id: 'root-a', depth: 1
    }, 25)
    h.agents.apply('subagent.start', {
      ...payload('cross-batch', 'group-b'), parent_id: 'root-a', depth: 1
    }, 26)

    expect(JSON.stringify(a.subagents)).toBe(beforeA)
    expect(JSON.stringify(b.subagents)).toBe(beforeB)
    expect(h.transcript.entries.filter(e => e.kind === 'turn').map(t => t.rev)).toEqual(revisions)
    h.agents.dispose()
  })

  it('requires consistent nested depth and task ordinals before binding a new group', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    h.agents.apply('subagent.start', { ...payload('root-a', 'group-a'), depth: 0 }, 10)
    const revisions = h.transcript.entries.filter(e => e.kind === 'turn').map(t => t.rev)

    h.agents.apply('subagent.start', {
      ...payload('bad-depth', 'group-c'), parent_id: 'root-a', depth: 2
    }, 11)
    h.agents.apply('subagent.start', {
      ...payload('bad-index', 'group-d'), parent_id: 'root-a', depth: 1,
      task_index: 2, task_count: 1
    }, 12)
    h.agents.apply('subagent.start', {
      ...payload('bad-count', 'group-e'), parent_id: 'root-a', depth: 1,
      task_index: 0, task_count: 0
    }, 13)

    expect(a.subagents?.map(agent => agent.id)).toEqual(['root-a'])
    expect(h.transcript.entries.filter(e => e.kind === 'turn').map(t => t.rev)).toEqual(revisions)
    h.agents.dispose()
  })

  it('rejects a reused nested batch id beneath another parent, including in the same call', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)
    h.agents.apply('subagent.start', { ...payload('root-a', 'group-a'), depth: 0 }, 20)
    h.agents.apply('subagent.start', { ...payload('other-a', 'group-a'), depth: 0 }, 21)
    h.agents.apply('subagent.start', { ...payload('root-b', 'group-b'), depth: 0 }, 22)
    h.agents.apply('subagent.start', {
      ...payload('nested-c', 'group-c'), parent_id: 'root-a', depth: 1
    }, 23)
    const beforeA = JSON.stringify(a.subagents)
    const beforeB = JSON.stringify(b.subagents)
    const revisions = h.transcript.entries.filter(e => e.kind === 'turn').map(t => t.rev)

    h.agents.apply('subagent.start', {
      ...payload('hijack', 'group-c'), parent_id: 'other-a', depth: 1
    }, 24)
    h.agents.apply('subagent.tool', {
      ...payload('nested-c', 'group-c'), parent_id: 'root-b', depth: 1, tool_name: 'terminal'
    }, 25)
    h.agents.apply('subagent.start', {
      ...payload('nested-c', 'new-group'), parent_id: 'root-a', depth: 1
    }, 26)

    expect(JSON.stringify(a.subagents)).toBe(beforeA)
    expect(JSON.stringify(b.subagents)).toBe(beforeB)
    expect(h.transcript.entries.filter(e => e.kind === 'turn').map(t => t.rev)).toEqual(revisions)
    h.agents.dispose()
  })

  it('rejects ambiguous duplicate parent ids even within two otherwise distinct root batches', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)
    h.agents.apply('subagent.start', { ...payload('root-a', 'group-a'), depth: 0 }, 20)
    attachRow(ownersOf(h.transcript.delegations()), b, 0, {
      delegation_id: 'group-b', depth: 0, goal: 'duplicate identity', subagent_id: 'root-a'
    })
    const beforeA = JSON.stringify(a.subagents)
    const beforeB = JSON.stringify(b.subagents)

    h.agents.apply('subagent.start', {
      ...payload('nested-c', 'group-c'), parent_id: 'root-a', depth: 1
    }, 21)

    expect(JSON.stringify(a.subagents)).toBe(beforeA)
    expect(JSON.stringify(b.subagents)).toBe(beforeB)
    h.agents.dispose()
  })

  it('rejects a nested anchor when a top-level delegation id is duplicated across calls', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    dispatched(h.transcript, 'call-b', 'group-a', 10)
    attachRow(ownersOf(h.transcript.delegations()), a, 0, {
      delegation_id: 'group-a', depth: 0, goal: 'known root', subagent_id: 'root-a'
    })
    const revisions = h.transcript.entries.filter(e => e.kind === 'turn').map(t => t.rev)

    h.agents.apply('subagent.start', {
      ...payload('nested-c', 'group-c'), parent_id: 'root-a', depth: 1
    }, 20)

    expect(a.subagents?.map(agent => agent.id)).toEqual(['root-a'])
    expect(h.transcript.entries.filter(e => e.kind === 'turn').map(t => t.rev)).toEqual(revisions)
    h.agents.dispose()
  })

  it('anchors a new nested batch under a uniquely attached resumed root', () => {
    const h = rig()
    h.transcript.load([
      { role: 'user', text: 'resume' },
      { args: { tasks: [{ goal: 'root task' }] }, name: 'delegate_task', role: 'tool', tool_call_id: 'resumed' }
    ])
    const call = must(h.transcript.delegations()[0])
    attachRow(ownersOf(h.transcript.delegations()), call, 0, {
      delegation_id: 'resumed-root', depth: 0, goal: 'root task', subagent_id: 'sa-0-resumed'
    })

    h.agents.apply('subagent.start', {
      ...payload('nested-c', 'group-c'), parent_id: 'sa-0-resumed', depth: 1
    }, 20)
    h.agents.apply('subagent.complete', { ...payload('nested-c', 'group-c'), status: 'completed' }, 21)

    expect(call.subagents?.find(agent => agent.id === 'nested-c')).toMatchObject({
      delegationId: 'group-c', depth: 1, parentId: 'sa-0-resumed', status: 'done'
    })
    h.agents.dispose()
  })

  it('rejects a repeated parent identity inside a single delegate call', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    h.agents.apply('subagent.start', { ...payload('root-a', 'group-a'), depth: 0 }, 10)
    attachRow(ownersOf(h.transcript.delegations()), a, 0, {
      delegation_id: 'group-a', depth: 0, goal: 'duplicate root', subagent_id: 'root-a'
    })
    const before = JSON.stringify(a.subagents)
    const revisions = h.transcript.entries.filter(e => e.kind === 'turn').map(t => t.rev)

    h.agents.apply('subagent.tool', {
      ...payload('nested-c', 'group-c'), parent_id: 'root-a', depth: 1, tool_name: 'terminal'
    }, 11)

    expect(JSON.stringify(a.subagents)).toBe(before)
    expect(h.transcript.entries.filter(e => e.kind === 'turn').map(t => t.rev)).toEqual(revisions)
    h.agents.dispose()
  })

  it('rejects a foreign explicit id without mutating either call or triggering attention', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)
    h.agents.apply('subagent.start', payload('worker-a', 'group-a'), 20)
    h.agents.apply('subagent.start', payload('worker-b', 'group-b'), 21)
    const beforeA = JSON.stringify(a.subagents)
    const beforeB = JSON.stringify(b.subagents)
    const revisions = h.transcript.entries.filter(e => e.kind === 'turn').map(t => t.rev)

    h.agents.apply('subagent.complete', { ...payload('foreign', 'group-foreign'), status: 'completed' }, 22)
    h.agents.apply('subagent.start', payload('worker-b', 'group-foreign'), 23)

    expect(JSON.stringify(a.subagents)).toBe(beforeA)
    expect(JSON.stringify(b.subagents)).toBe(beforeB)
    expect(h.transcript.entries.filter(e => e.kind === 'turn').map(t => t.rev)).toEqual(revisions)
    expect(h.ended).not.toHaveBeenCalled()
    expect(h.changed).not.toHaveBeenCalled()
    h.agents.dispose()
  })

  it('treats a supplied empty delegation id as invalid, not legacy id-less traffic', () => {
    const h = rig()
    const call = dispatched(h.transcript, 'call-a', 'group-a', 0)

    h.agents.apply('subagent.start', payload('foreign', ''), 10)

    expect(call.subagents).toBeUndefined()
    h.agents.dispose()
  })

  it('accepts a genuinely id-less event only with a single possible delegate call', () => {
    const h = rig()
    const call = dispatched(h.transcript, 'call-a', 'group-a', 0)

    h.agents.apply('subagent.start', payload('legacy-child'), 5)
    h.agents.apply('subagent.complete', { ...payload('legacy-child'), status: 'completed' }, 6)

    expect(call.subagents).toMatchObject([{ delegationId: 'group-a', id: 'legacy-child', status: 'done' }])
    h.agents.dispose()
  })

  it('routes id-less late progress by an existing child id, not the newest task', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)
    h.agents.apply('subagent.start', payload('worker-a', 'group-a'), 20)
    h.agents.apply('subagent.start', payload('worker-b', 'group-b'), 21)

    h.agents.apply('subagent.tool', { ...payload('worker-a'), tool_name: 'read_file' }, 30)

    expect(a.subagents?.[0]).toMatchObject({ id: 'worker-a', tool: 'read_file' })
    expect(b.subagents?.[0]?.id).toBe('worker-b')
    expect(b.subagents?.[0]?.tool).toBeUndefined()
    h.agents.dispose()
  })

  it('drops id-less unknown children when two completed calls could own them', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)

    h.agents.apply('subagent.start', payload('unknown'), 20)

    expect(a.subagents).toBeUndefined()
    expect(b.subagents).toBeUndefined()
    h.agents.dispose()
  })

  it('does not cross-bind conflicting child and parent identity hints', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)
    h.agents.apply('subagent.start', payload('worker-a', 'group-a'), 20)
    h.agents.apply('subagent.start', payload('worker-b', 'group-b'), 21)

    h.agents.apply('subagent.tool', { ...payload('worker-a'), parent_id: 'worker-b', tool_name: 'terminal' }, 22)

    expect(a.subagents?.[0]?.tool).toBeUndefined()
    expect(b.subagents?.[0]?.tool).toBeUndefined()
    h.agents.dispose()
  })

  it('rejects reused child ids when their explicit delegation ids disagree', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)
    h.agents.apply('subagent.start', payload('worker-a', 'group-a'), 20)

    h.agents.apply('subagent.complete', { ...payload('worker-a', 'group-b'), status: 'completed' }, 21)

    expect(a.subagents?.[0]?.status).toBe('running')
    expect(b.subagents).toBeUndefined()
    h.agents.dispose()
  })

  it('keeps a late completion on A after B opens a new turn', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)
    h.agents.apply('subagent.start', payload('worker-a', 'group-a'), 20)
    h.agents.apply('subagent.start', payload('worker-b', 'group-b'), 21)

    h.agents.apply('subagent.complete', { ...payload('worker-a', 'group-a'), status: 'completed', summary: 'A finished' }, 30)

    expect(a.subagents?.[0]).toMatchObject({ status: 'done', summary: 'A finished' })
    expect(b.subagents?.[0]).toMatchObject({ status: 'running' })
    h.agents.dispose()
  })

  it('keeps explicit parent links and flattens a later cyclic parent edge', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    h.agents.apply('subagent.start', payload('root', 'group-a'), 10)
    h.agents.apply('subagent.start', { ...payload('child', 'group-c'), parent_id: 'root', depth: 1 }, 11)

    expect(a.subagents?.find(x => x.id === 'child')).toMatchObject({
      delegationId: 'group-c', depth: 1, parentId: 'root'
    })

    h.agents.apply('subagent.progress', { ...payload('root', 'group-a'), parent_id: 'child' }, 12)

    expect(a.subagents?.find(x => x.id === 'root')).toMatchObject({ depth: 0 })
    expect(a.subagents?.find(x => x.id === 'root')?.parentId).toBeUndefined()
    expect(a.subagents?.find(x => x.id === 'child')?.parentId).toBe('root')
    h.agents.dispose()
  })

  it('does not create a self-parented or already cyclic agent', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)

    h.agents.apply('subagent.start', { ...payload('same', 'group-a'), parent_id: 'same', depth: 1 }, 10)

    expect(a.subagents?.[0]).toMatchObject({ depth: 0 })
    expect(a.subagents?.[0]?.parentId).toBeUndefined()
    h.agents.dispose()
  })

  it('finds a resumed owner from the registry-attached row without a tool result', () => {
    const h = rig()
    h.transcript.load([
      { role: 'user', text: 'resume' },
      { args: { tasks: [{ goal: 'resume goal' }] }, name: 'delegate_task', role: 'tool', tool_call_id: 'resumed' }
    ])
    const call = must(h.transcript.delegations()[0])
    const row = attachRow(ownersOf(h.transcript.delegations()), call, 0, {
      delegation_id: 'resumed-group', depth: 0, goal: 'resume goal', subagent_id: 'sa-0-resumed'
    })

    h.agents.apply('subagent.complete', { ...payload('sa-0-resumed', 'resumed-group'), status: 'completed' }, 20)

    expect(row).toMatchObject({ delegationId: 'resumed-group', status: 'done' })
    expect(call.subagents).toHaveLength(1)
    h.agents.dispose()
  })

  it('does not attach a prior-session event after adoption of a different session', () => {
    const h = rig()
    dispatched(h.transcript, 'old', 'old-group', 0)
    h.setSession('session-b')
    h.transcript.reset({ session: 'other', usage: undefined })
    const current = dispatched(h.transcript, 'current', 'new-group', 20)
    const event = payload('stale', 'old-group')

    // This is the real gateway envelope guard; the payload alone has no session id.
    expect(routeEvent(liveSessionId('session-b'), false, {
      session_id: 'session-a', type: 'subagent.complete'
    })).toBe('drop')
    h.agents.apply('subagent.complete', { ...event, status: 'completed' }, 30)

    expect(current.subagents).toBeUndefined()
    h.agents.dispose()
  })

  it('settles only the matching delegation, never the other batch at the same task index', () => {
    const h = rig()
    const a = dispatched(h.transcript, 'call-a', 'group-a', 0)
    const b = dispatched(h.transcript, 'call-b', 'group-b', 10)
    h.agents.apply('subagent.start', payload('worker-a', 'group-a'), 20)
    h.agents.apply('subagent.start', payload('worker-b', 'group-b'), 21)

    h.agents.settle('[ASYNC DELEGATION COMPLETE — group-a]\n\nStatus: completed')

    expect(a.subagents?.[0]?.status).toBe('done')
    expect(b.subagents?.[0]?.status).toBe('running')

    h.agents.settle('[ASYNC DELEGATION COMPLETE — foreign-group]\n\nStatus: failed')
    expect(b.subagents?.[0]?.status).toBe('running')
    h.agents.dispose()
  })
})
