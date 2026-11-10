// The subagent rows of the Task cards, and how each source folds into them: a delegate_task
// dispatch result makes the rows, a `subagent.*` event makes or moves one (and tells its end), a
// `subagent.list` row moves one (or adds a nested child under its parent, or a resumed session's
// child under the call that asked for it), and an async-delegation completion tells an end
// nothing else did. Each row's node key is fixed when it is made. Pure: the store (store.ts) does
// the reading and the polling, and is the only writer of the rows.

import type { SubagentEventPayload, SubagentSnapshot } from '@hermes/shared/gateway-events'

import { optional } from '../core/assert.js'
import { subagentKey } from '../core/ids.js'
import type { Subagent, ToolCall } from '../model.js'
import { parseJson, record } from '../wire/json.js'

/** One row of `subagent.list` (gateway/session_ancillary.py `_SUBAGENT_FIELDS`). */
export type ListRow = SubagentSnapshot

/** The `subagent.*` events. */
export type SubagentEventType =
  | 'subagent.complete'
  | 'subagent.progress'
  | 'subagent.spawn_requested'
  | 'subagent.start'
  | 'subagent.thinking'
  | 'subagent.tool'

/** One `subagent.*` event: its type, its payload, and when it arrived. */
export interface SubagentEvent {
  type: SubagentEventType
  event: SubagentEventPayload
  at: number
}

/** Each agent with the delegate_task call whose card shows it. */
export type Owners = Map<Subagent, ToolCall>

const ENDED = new Set(['cancelled', 'done', 'failed'])
/** The note on a row that ended where nothing said how; the async-delegation completion replaces it. */
export const OUTCOME_UNKNOWN = 'outcome unknown'

export function isRunning(a: Subagent): boolean {
  return !ENDED.has(a.status)
}

/** `Agent 2`, or `Agent 2.1` for the first child that agent spawned. */
export function agentName(a: Subagent): string {
  return a.name ?? `Agent ${a.index + 1}`
}

/** Each agent of `calls` (delegate_task calls) with the call whose card shows it, each call's rows in order. */
export function ownersOf(calls: readonly ToolCall[]): Owners {
  const owners: Owners = new Map()

  for (const call of calls) {
    for (const a of call.subagents ?? []) {
      owners.set(a, call)
    }
  }

  return owners
}

/** Orders a card's rows: by task, each task's nested children after it. */
const byTask = (x: Subagent, y: Subagent) => x.index - y.index || (x.depth ?? 0) - (y.depth ?? 0)

/** What a dispatched delegate_task call's result names: its delegation and, by task, goals and ids. */
export interface Dispatch {
  delegationId: string
  goals: string[]
  ids: unknown[]
}

/** The dispatch a delegate_task result tells of; undefined for any other result (a foreground run's). */
export function dispatchOf(result: unknown): Dispatch | undefined {
  const { delegation_id: delegationId, goals, status, subagent_ids: ids } = record(result) ?? {}

  if (status !== 'dispatched' || typeof delegationId !== 'string') {
    return undefined
  }

  return {
    delegationId,
    goals: Array.isArray(goals) ? goals.map(g => (typeof g === 'string' ? g : '')) : [],
    ids: Array.isArray(ids) ? ids : []
  }
}

/** The rows of dispatch `d` (one per goal), merged into the rows `list` (its call's) already holds. */
export function dispatchRows(list: Subagent[], d: Dispatch, at: number) {
  d.goals.forEach((goal, i) => {
    const named = d.ids[i]
    const id = typeof named === 'string' && named ? named : `task-${i}`
    let a = list.find(x => x.id === id)

    if (!a) {
      // The node key stays put when the first poll renames a `task-<i>` placeholder, so Tern keeps its timer.
      a = { calls: 0, goal, id, index: i, key: subagentKey(`p${i}`), startedAt: at, status: 'queued', tokens: 0, toolCount: 0 }
      list.push(a)
    }

    a.delegationId = d.delegationId
    a.depth = 0
  })

  list.sort(byTask)
}

/** The row `row` describes: by id, else a dispatch placeholder (`task-<i>`) of its delegation. */
export function findRow(owners: Owners, row: ListRow): Subagent | undefined {
  const agents = [...owners.keys()]
  const byId = agents.find(a => a.id === row.subagent_id)

  if (byId) {
    return byId
  }

  const index = taskIndex(row)

  return (row.depth ?? 0) === 0 && index !== undefined
    ? agents.find(a => a.delegationId === row.delegation_id && a.id === `task-${index}`)
    : undefined
}

/** A nested child (an orchestrator's worker): a row under its parent, in the parent's card. */
export function nestedChild(owners: Owners, row: ListRow): Subagent | undefined {
  const parent = [...owners.keys()].find(a => a.id === row.parent_id)
  const call = parent && owners.get(parent)

  if (!parent || !call?.subagents) {
    return undefined
  }

  const list = call.subagents
  const siblings = list.filter(a => a.parentId === parent.id).length
  const child: Subagent = {
    calls: 0,
    delegationId: row.delegation_id ?? undefined,
    depth: (parent.depth ?? 0) + 1,
    goal: row.goal ?? '',
    id: row.subagent_id,
    index: parent.index,
    key: subagentKey(row.subagent_id),
    name: `${agentName(parent)}.${siblings + 1}`,
    parentId: parent.id,
    startedAt: Date.now(),
    status: 'running',
    tokens: 0,
    toolCount: 0
  }

  // After the parent's last descendant, so the card reads as a tree.
  let at = list.indexOf(parent) + 1

  while (at < list.length && (list[at]?.depth ?? 0) > (parent.depth ?? 0)) {
    at++
  }

  list.splice(at, 0, child)
  owners.set(child, call)

  return child
}

/**
 * The call a top-level child whose dispatch result the history dropped (a resumed session) belongs
 * under: the newest result-less delegate_task call whose task `sa-<i>-` asked for its goal, with no
 * row for that task yet. Undefined for a nested child or one no call asked for.
 */
export function askingCall(calls: readonly ToolCall[], row: ListRow): { call: ToolCall; index: number } | undefined {
  const index = taskIndex(row)
  const goal = row.goal?.trim()

  if ((row.depth ?? 0) !== 0 || index === undefined || !goal) {
    return undefined
  }

  const call = calls.findLast(c => c.result === undefined && taskGoals(c)[index] === goal && !c.subagents?.some(a => !a.depth && a.index === index))

  return call && { call, index }
}

/** Adds the row of resumed child `row` (task `index`) to `call`'s card. */
export function attachRow(owners: Owners, call: ToolCall, index: number, row: ListRow): Subagent {
  const a: Subagent = {
    calls: 0,
    delegationId: row.delegation_id ?? undefined,
    depth: 0,
    goal: row.goal ?? '',
    id: row.subagent_id,
    index,
    key: subagentKey(`p${index}`),
    startedAt: Date.now(),
    status: 'running',
    tokens: 0,
    toolCount: 0
  }
  const list = (call.subagents ??= [])

  list.push(a)
  list.sort(byTask)
  owners.set(a, call)

  return a
}

/**
 * Folds a `subagent.list` row into the agent it describes: it is live, with its model, counts and
 * step. True when the row had ended unseen and runs again.
 */
export function applyListRow(a: Subagent, row: ListRow): boolean {
  a.id = row.subagent_id
  // Ended unseen, then listed after all (it waited for a slot): it runs.
  const revived = a.status === 'done' && a.exitReason === OUTCOME_UNKNOWN

  if (revived) {
    a.status = 'running'
    a.exitReason = undefined
  }

  a.model = row.model ?? a.model
  // A higher count is a new call, even of the same tool.
  const started = (row.tool_count ?? 0) > a.toolCount
  a.toolCount = Math.max(a.toolCount, row.tool_count ?? 0)
  a.steerable = row.accepting_steer ?? a.steerable
  a.startedAt = typeof row.started_at === 'number' ? row.started_at * 1000 : a.startedAt

  if (a.status === 'queued' || a.status === 'running') {
    a.status = 'running'

    // A row no tool event reaches (none at all, or a nested child's start and end only) shows the
    // owner's last started tool; a top-level row's events name its own.
    if ((!a.last || a.depth) && row.last_tool && (a.tool !== row.last_tool || started)) {
      a.tool = row.last_tool
      a.toolSince = { at: Date.now() }
    }
  }

  return revived
}

/** Ends a row nothing said the end of (it left the list, or was never listed): done, its outcome unknown. */
export function endUnseen(a: Subagent) {
  a.status = 'done'
  a.exitReason = OUTCOME_UNKNOWN
  a.duration = Date.now() - a.startedAt
  a.tool = undefined
}

/**
 * Each task's status in an async-delegation completion's model text: the batch block's
 * `--- ✓ TASK i/n … (status=…` headers, a lone task's `Status:` line, or a still-running fan-out's
 * one failed task. Undefined for any other text.
 */
export function completionOutcomes(text: string): { delegationId: string; outcomes: Map<number, string> } | undefined {
  const head = /^\[ASYNC DELEGATION (BATCH COMPLETE|COMPLETE|TASK FAILED) — ([^\],]+)(?:, task (\d+)\/\d+)?\]/.exec(text.trim())

  if (!head) {
    return undefined
  }

  const [, kind, delegationId = '', task] = head
  const outcomes = new Map<number, string>()

  if (kind === 'BATCH COMPLETE') {
    for (const [, n, status] of text.matchAll(/^--- \S+ TASK (\d+)\/\d+.*\(status=([^,)\s]+)/gm)) {
      if (status) {
        outcomes.set(Number(n) - 1, status)
      }
    }
  } else {
    const status = /^Status: (\S+)/m.exec(text)?.[1]

    if (status) {
      outcomes.set(kind === 'TASK FAILED' ? Number(task) - 1 : 0, status)
    }
  }

  return { delegationId: delegationId.trim(), outcomes }
}

/** Completion statuses the row's status already says; others (timeout, stalled, …) also show as its end reason. */
const PLAIN_OUTCOMES = new Set(['cancelled', 'completed', 'error', 'failed', 'interrupted', 'success'])

/**
 * Applies task status `status` from a completion to row `a`, whose end the owner did not report;
 * false when the status says nothing (`?`).
 */
export function applyOutcome(a: Subagent, status: string): boolean {
  const ended = endedStatus(status)

  if (!ended) {
    return false
  }

  if (isRunning(a)) {
    a.duration = Date.now() - a.startedAt
  }

  a.status = ended
  a.tool = undefined
  a.exitReason = status === 'unknown' ? OUTCOME_UNKNOWN : PLAIN_OUTCOMES.has(status) ? undefined : status

  return true
}

/** How a row ended. */
export type EndedStatus = Extract<Subagent['status'], 'cancelled' | 'done' | 'failed'>

/**
 * An ended child's status as its row says it, whoever reports it: the owner's `subagent.complete`
 * (SubagentStatus) or an async-delegation completion. Completed (or success,
 * or unknown: it ended, nothing says it failed) is done; interrupted or cancelled is cancelled;
 * any other end (failed, error, timeout, …) failed. Undefined for one that says nothing (`?`).
 */
export function endedStatus(status: string): EndedStatus | undefined {
  if (status === '?') {
    return undefined
  }

  if (status === 'completed' || status === 'success' || status === 'unknown') {
    return 'done'
  }

  return status === 'interrupted' || status === 'cancelled' ? 'cancelled' : 'failed'
}

/**
 * Folds `subagent.*` event `e` into `call`'s rows and returns the row it moved: the row for its
 * subagent (a new one in task order, or a nested child under its parent), its counts, its status
 * and its current tool. An end that says nothing of how is a failure, as the owner reports a
 * success.
 */
export function foldEvent(call: ToolCall, { type, event, at }: SubagentEvent): Subagent {
  const list = (call.subagents ??= [])
  const id = event.subagent_id ?? `task-${event.task_index}`
  let agent = list.find(a => a.id === id)

  if (!agent && event.subagent_id && event.parent_id) {
    agent = nestedChild(ownersOf([call]), {
      ...optional('delegation_id', event.delegation_id),
      goal: event.goal,
      parent_id: event.parent_id,
      subagent_id: event.subagent_id
    })
    if (agent && type === 'subagent.spawn_requested') {
      agent.status = 'queued'
      agent.startedAt = at
    }
  }

  if (!agent) {
    agent = { calls: 0, goal: event.goal, id, index: event.task_index, key: subagentKey(id), startedAt: at, status: 'queued', tokens: 0, toolCount: 0 }
    list.push(agent)
    list.sort(byTask)
  }

  agent.last = event
  agent.goal = event.goal || agent.goal
  agent.model = event.model ?? agent.model
  agent.toolCount = event.tool_count ?? agent.toolCount
  agent.calls = event.api_calls ?? agent.calls
  agent.tokens = (event.input_tokens ?? 0) + (event.output_tokens ?? 0) || agent.tokens

  if (type === 'subagent.start') {
    agent.status = 'running'
    agent.startedAt = at
  } else if (type === 'subagent.tool') {
    agent.status = 'running'
    agent.tool = event.tool_name ?? agent.tool
    agent.toolPreview = event.tool_preview ?? event.text ?? undefined
    agent.toolSince = { at }
  } else if (type === 'subagent.thinking') {
    // The child asks its model again: the tool it ran has returned.
    agent.status = 'running'
    agent.tool = undefined
  } else if (type === 'subagent.complete') {
    const status = event.status ?? ''
    agent.status = endedStatus(status) ?? 'failed'
    agent.exitReason = PLAIN_OUTCOMES.has(status) ? undefined : status || undefined
    agent.summary = event.summary ?? undefined
    agent.duration =
      typeof event.duration_seconds === 'number' ? Math.round(event.duration_seconds * 1000) : at - agent.startedAt
    agent.tool = undefined
  } else if (event.status === 'running') {
    agent.status = 'running'
  }

  return agent
}

/** The owner's `subagent.complete` told how `a` ended. */
export function endReported(a: Subagent): boolean {
  const status = a.last?.status

  return status !== undefined && status !== null && status !== 'queued' && status !== 'running'
}

/** The task index a top-level child's id names (`sa-<i>-…`, tools/delegate_tool.py). */
function taskIndex(row: ListRow): number | undefined {
  const index = Number(/^sa-(\d+)-/.exec(row.subagent_id)?.[1])

  return Number.isInteger(index) ? index : undefined
}

/** The goals a delegate_task call asked for, by task index: its `tasks`, else its one `goal`. */
function taskGoals(call: ToolCall): string[] {
  const { goal, tasks: raw } = call.args
  const tasks = typeof raw === 'string' ? parseJson(raw) : raw

  if (Array.isArray(tasks) && tasks.length) {
    return tasks.map(t => {
      const { goal: task } = record(t) ?? {}

      return typeof task === 'string' ? task.trim() : ''
    })
  }

  return typeof goal === 'string' ? [goal.trim()] : []
}
