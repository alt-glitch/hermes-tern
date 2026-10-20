// The delegate_task tool: omp's task card (one agent row each), or one agent's own row in its place.

import type { JSX } from '@stencil-hq/tern'

import { agentNode } from '../../../agents/agentRow.js'
import type { ToolCall } from '../../../model.js'
import { record } from '../../../wire/json.js'
import { nonEmpty, plural } from '../../format.js'
import type { Card } from '../types.js'

/** A delegation: its agents' rows (or the requested goals before they report), and the brief they share. */
export function taskCard(call: ToolCall, result: Record<string, unknown> | undefined, now: number): Card {
  const tasks = Array.isArray(call.args.tasks) ? call.args.tasks.map(t => record(t)).filter(t => t !== undefined) : []

  const goals = tasks.length
    ? tasks.map(t => nonEmpty(t.goal) ?? '')
    : nonEmpty(call.args.goal)
      ? [nonEmpty(call.args.goal) ?? '']
      : []

  const agents = call.subagents ?? []

  // Until the first subagent event, the requested tasks stand in as pending rows.
  const rows = agents.length
    ? agents.map(a => agentNode(a, now))
    : call.status === 'running' || result?.status === 'dispatched'
      ? goals.map((g, i) => <agent key={`p${i}`} name={`Agent ${i + 1}`} status="pending" task={g} />)
      : settledRows(goals, result)

  const context = nonEmpty(call.args.context) ?? (tasks.length === 1 ? nonEmpty(tasks[0]?.context) : undefined)

  const working =
    agents.some(a => a.status === 'running' || a.status === 'queued') ||
    (!agents.length && result?.status === 'dispatched')

  const settled = agents.filter(a => a.status !== 'running' && a.status !== 'queued')
  const count = goals.length || agents.length
  let meta: string | undefined
  let took: number | undefined

  if (agents.length && !working) {
    const ok = agents.filter(a => a.status === 'done').length
    const stopped = agents.filter(a => a.status === 'cancelled').length
    const failed = agents.length - ok - stopped
    const requests = agents.reduce((n, a) => n + a.calls, 0)
    meta = [
      `${ok} succeeded`,
      failed ? `${failed} failed` : '',
      stopped ? `${stopped} stopped` : '',
      requests ? `${requests} req` : ''
    ]
      .filter(Boolean)
      .join(' · ')
    took = Math.max(...agents.map(a => a.startedAt + (a.duration ?? 0))) - call.startedAt
  } else if (settled.length) {
    meta = `${settled.length} of ${count} done`
  }

  return {
    badges: result?.mode === 'background' ? [{ text: 'background' }] : undefined,
    // The agents first; the brief they share stays folded.
    body: [...rows, ...(context ? [briefNode('Shared brief', context)] : [])],
    meta: meta ? [meta] : undefined,
    name: 'task',
    status: working ? 'running' : undefined,
    target: count ? plural(count, 'agent') : undefined,
    targetKind: 'text',
    title: 'Task',
    took
  }
}

/**
 * A settled delegation with no subagent events (a resumed session): its goals, each with the
 * outcome `result.results` gives it, as the desktop's delegateRowsFromCall. History drops the
 * result, so a goal with none reads idle rather than done or failed.
 */
function settledRows(goals: string[], result: Record<string, unknown> | undefined): JSX.Element[] {
  const results = Array.isArray(result?.results) ? result.results.map(r => record(r)) : []
  const titles = goals.length ? goals : results.map(() => 'Delegated task')

  return titles.map((g, i) => {
    const { status, summary } = outcome(results[i])

    return (
      <agent key={`s${i}`} name={`Agent ${i + 1}`} status={status} task={g}>
        {summary ? <md key="o">{summary}</md> : null}
      </agent>
    )
  })
}

/** A settled agent's status and report from its `result.results` entry (none: idle). */
function outcome(r: Record<string, unknown> | undefined): { status: string; summary?: string } {
  const verdict = nonEmpty(r?.status) ?? ''
  // As the desktop's settledRowStatus: anything but a success (a timeout, an error) failed.
  const status = !r ? 'idle' : verdict === '' || verdict === 'ok' || verdict === 'completed' ? 'done' : 'failed'

  return { status, summary: nonEmpty(r?.summary) ?? nonEmpty(r?.error) }
}

/**
 * A delegation of one agent, as one row: the agent's own (status, goal, model, its current tool
 * and timer), named "Background agent" when it runs on its own. Its brief is in the agent's
 * sheet (a click away), not here. A failed dispatch keeps the Task card, which says why.
 */
export function soloTask(call: ToolCall, now: number): JSX.Element | undefined {
  const tasks = Array.isArray(call.args.tasks) ? call.args.tasks.map(t => record(t)).filter(t => t !== undefined) : []
  const result = record(call.result)

  if (tasks.length > 1 || (call.subagents?.length ?? 0) > 1 || call.status === 'error' || result?.error) {
    return undefined
  }

  const goal = nonEmpty(tasks[0]?.goal) ?? nonEmpty(call.args.goal) ?? call.subagents?.[0]?.goal ?? 'Delegated task'
  const name = result?.mode === 'background' ? 'Background agent' : 'Agent'
  const a = call.subagents?.[0]

  if (a) {
    return agentNode(a, now, { key: call.id, name })
  }

  // Before its first event the request stands in; a resumed one has only its result.
  const pending = call.status === 'running' || result?.status === 'dispatched'
  const results = Array.isArray(result?.results) ? result.results.map(r => record(r)) : []
  const { status, summary } = pending ? { status: 'pending', summary: undefined } : outcome(results[0])

  return (
    <agent
      collapsed={summary ? true : undefined}
      collapsible={summary ? true : undefined}
      key={call.id}
      name={name}
      role="hermes.task.solo"
      status={status}
      task={goal}
    >
      {summary ? <md key="o">{summary}</md> : null}
    </agent>
  )
}

/** The brief (`context`) delegation `call` gave its agent `index` beside the goal, if any. */
export function briefOf(call: ToolCall, index: number): string | undefined {
  const tasks = Array.isArray(call.args.tasks) ? call.args.tasks.map(t => record(t)) : []
  const context = nonEmpty(tasks[index]?.context) ?? nonEmpty(call.args.context)

  return context
}

/** A delegation's brief, folded: what the agents were told. */
function briefNode(head: string, text: string): JSX.Element {
  return (
    <section collapsed collapsible head={head} key="brief" role="hermes.task.brief">
      <md key="md">{text}</md>
    </section>
  )
}
