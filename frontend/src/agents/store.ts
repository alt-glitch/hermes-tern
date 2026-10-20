// Live subagent state for the Task cards, the agents pill and the hub. The shared gateway does not
// forward `subagent.*` events to viewers, so this reads what it does serve: `subagent.list` (the
// owner's live registry: status, model, tool count, steerability) and each child's live
// transcript log (tools/delegation_live_log.py), whose path the dispatch result names. The log
// outlives the child, so a finished agent keeps its timeline and final status. Where a gateway
// does send `subagent.*` events, Transcript.subagent folds them into the same rows. A resumed
// session's history drops the dispatch result, so its still-running children are found by one
// `subagent.list` probe and attached to the delegate_task call that asked for their goals.

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { SubagentSnapshot } from '@hermes/shared/gateway-events'
import type { GatewayClient } from '@tui/gatewayClient.js'

import type { LiveSessionId } from '../core/ids.js'
import type { Subagent, ToolCall } from '../model.js'
import type { Transcript } from '../transcript.js'
import { record } from '../wire/json.js'
import { rpc } from '../wire/rpc.js'

import { clockToMs, parseLiveLog, runningTool, type LiveLog } from './liveLog.js'

/** What the store reaches of the app. */
export interface AgentsHost {
  readonly gw: Pick<GatewayClient, 'request'>
  /** The open session's runtime id. */
  readonly sid: LiveSessionId | null
  readonly transcript: Transcript
  changed(): void
  /** A subagent ended (the PRs it linked may be new). */
  agentEnded?(): void
}

/** One row of `subagent.list` (gateway/session_ancillary.py `_SUBAGENT_FIELDS`). */
type ListRow = SubagentSnapshot

const POLL_MS = 1000
/** Logs are compact (one capped line per event); a runaway one is read from its tail. */
const MAX_LOG_BYTES = 2 * 1024 * 1024
const ENDED = new Set(['cancelled', 'done', 'failed'])
/** Polls a child with no log this process can read may go unlisted before it counts as ended (it can finish inside the first one). */
const GRACE_POLLS = 3
/** The note on a row that ended where nothing said how; the async-delegation completion replaces it. */
export const OUTCOME_UNKNOWN = 'outcome unknown'

export function isRunning(a: Subagent): boolean {
  return !ENDED.has(a.status)
}

/** `Agent 2`, or `Agent 2.1` for the first child that agent spawned. */
export function agentName(a: Subagent): string {
  return a.name ?? `Agent ${a.index + 1}`
}

export class Agents {
  readonly #host: AgentsHost
  #timer: NodeJS.Timeout | undefined
  #ticking = false
  readonly #tracked = new WeakSet<ToolCall>()
  /** Log sizes at the last read, by path; a log that did not grow is not read again. */
  readonly #sizes = new Map<string, number>()
  /** Logs this process cannot read (a gateway on another machine): `subagent.tail` instead. */
  readonly #unreadable = new Set<string>()
  /** Ids `subagent.list` reported: one that leaves the list has finished. */
  readonly #listed = new Set<string>()
  /** Polls each unlisted row without a readable log has gone unseen. */
  readonly #unseen = new WeakMap<Subagent, number>()
  /** Rows whose end the host heard of. */
  readonly #ended = new WeakSet<Subagent>()
  /** The `subagent.tail` text read so far, by subagent id: each tail (the last 16 KB) is merged onto it. */
  readonly #tails = new Map<string, string>()
  /**
   * New delegate_task spawns are blocked, as this pane last set it (`delegation.pause`); undefined
   * until then (the shared gateway serves no `delegation.status`). The gate is gateway-wide.
   */
  paused: boolean | undefined

  constructor(host: AgentsHost) {
    this.#host = host
  }

  /** Every agent of the session's delegations, each delegation's rows in order. */
  all(): Subagent[] {
    return [...this.#owners().keys()]
  }

  running(): Subagent[] {
    return this.all().filter(isRunning)
  }

  /**
   * Takes over each dispatched delegate_task call not tracked yet, and polls while any agent runs.
   * A call history brought back without its result (a resumed session) gets one `subagent.list`
   * probe: its children still running are attached to it and followed from then on.
   */
  scan(at = Date.now()) {
    let bare = false

    for (const call of this.#host.transcript.delegations()) {
      if (this.#tracked.has(call)) {
        continue
      }

      if (this.#track(call, at)) {
        this.#tracked.add(call)
      } else if (call.result === undefined && call.status !== 'running' && !call.subagents?.length) {
        bare = true
      }
    }

    if (this.running().length) {
      this.#wake()
    } else if (bare) {
      void this.#tick(true)
    }
  }

  /** Queues steering text into a running agent; the owner answers `queued` or `rejected`. */
  async steer(a: Subagent, text: string): Promise<boolean> {
    const sid = this.#host.sid

    if (!sid) {
      return false
    }

    const r = await rpc(this.#host.gw, 'subagent.steer', { session_id: sid, subagent_id: a.id, text })

    return r?.status === 'queued'
  }

  /** Interrupts a running agent; its partial result still returns to the parent. */
  async stop(a: Subagent): Promise<boolean> {
    const sid = this.#host.sid

    if (!sid) {
      return false
    }

    const r = await rpc(this.#host.gw, 'subagent.interrupt', { session_id: sid, subagent_id: a.id })

    return Boolean(r?.found)
  }

  /** Blocks (or unblocks) new subagent spawns on the gateway; running children keep going. */
  async pause(paused: boolean): Promise<boolean> {
    const r = await rpc(this.#host.gw, 'delegation.pause', { paused, ...(this.#host.sid ? { session_id: this.#host.sid } : {}) })

    this.paused = typeof r?.paused === 'boolean' ? r.paused : paused
    this.#host.changed()

    return this.paused
  }

  /**
   * Applies an async-delegation completion (the model text of its `message.start`,
   * tools/process_registry_notifications.py) to the rows whose log never told their outcome.
   */
  settle(text: string) {
    const done = completionOutcomes(text)

    if (!done) {
      return
    }

    let changed = false

    for (const a of this.all()) {
      const status = a.depth ? undefined : done.outcomes.get(a.index)

      if (a.delegationId !== done.delegationId || status === undefined || a.log?.status) {
        continue
      }

      const ended = endedStatus(status)

      if (!ended) {
        continue
      }

      if (isRunning(a)) {
        a.duration = Date.now() - a.startedAt
      }

      a.status = ended
      a.tool = undefined
      a.exitReason = status === 'unknown' ? OUTCOME_UNKNOWN : PLAIN_OUTCOMES.has(status) ? undefined : status
      this.#touch(a)
      changed = true
    }

    if (changed) {
      this.#host.changed()
    }
  }

  /** Reads `a`'s log now (the hub's timeline opening on it), whatever its state. */
  async refresh(a: Subagent) {
    if (await this.#readLog(a, true)) {
      this.#touch(a)
      this.#host.changed()
    }
  }

  dispose() {
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  #track(call: ToolCall, at: number): boolean {
    const r = record(call.result)

    if (r?.status !== 'dispatched' || typeof r.delegation_id !== 'string') {
      return false
    }

    const goals = Array.isArray(r.goals) ? r.goals.map(g => (typeof g === 'string' ? g : '')) : []
    const ids = Array.isArray(r.subagent_ids) ? r.subagent_ids : []
    const paths = Array.isArray(r.live_transcripts) ? r.live_transcripts : []
    const list = (call.subagents ??= [])

    goals.forEach((goal, i) => {
      const id = typeof ids[i] === 'string' && ids[i] ? (ids[i] as string) : `task-${i}`
      let a = list.find(x => x.id === id)

      if (!a) {
        a = { calls: 0, goal, id, index: i, startedAt: at, status: 'queued', tokens: 0, toolCount: 0 }
        list.push(a)
      }

      // The node key stays put when the first poll renames a `task-<i>` placeholder, so Tern keeps its timer.
      a.key ??= `p${i}`
      a.delegationId = r.delegation_id as string
      a.depth = 0
      a.logPath = typeof paths[i] === 'string' ? (paths[i] as string) : undefined
    })

    list.sort((a, b) => a.index - b.index || (a.depth ?? 0) - (b.depth ?? 0))

    return true
  }

  #wake() {
    this.#timer ??= setInterval(() => void this.#tick(), POLL_MS)
    void this.#tick()
  }

  /** One poll and log read; `probe` polls even with nothing running yet (a resumed session). */
  async #tick(probe = false) {
    if (this.#ticking) {
      return
    }

    this.#ticking = true

    try {
      if (!probe && !this.running().length) {
        return this.dispose()
      }

      const changed = new Set<Subagent>()
      await this.#poll(changed)
      const reads = await Promise.all(this.running().map(async a => ((await this.#readLog(a)) ? a : undefined)))
      reads.forEach(a => a && changed.add(a))

      if (changed.size) {
        changed.forEach(a => this.#touch(a))
        this.#host.changed()
      }

      // A probe that found live children keeps following them.
      if (probe && this.running().length) {
        this.#timer ??= setInterval(() => void this.#tick(), POLL_MS)
      }
    } finally {
      this.#ticking = false
    }
  }

  /** Folds `subagent.list` into the rows: new nested children, status, model, counts. */
  async #poll(changed: Set<Subagent>) {
    const sid = this.#host.sid

    if (!sid) {
      return
    }

    let rows: ListRow[]

    try {
      rows = (await rpc(this.#host.gw, 'subagent.list', { session_id: sid }))?.subagents ?? []
    } catch {
      // A session the owner no longer holds live (or a worker it cannot project): the logs still tell.
      return
    }

    const owners = this.#owners()
    const present = new Set<string>()

    for (const row of rows) {
      const id = row.subagent_id

      if (!id) {
        continue
      }

      present.add(id)
      this.#listed.add(id)
      const a = this.#find(owners, row) ?? this.#adopt(owners, row) ?? (await this.#attach(owners, row))

      if (!a) {
        continue
      }

      a.id = id
      // Ended unseen, then listed after all (it waited for a slot): it runs.
      if (a.status === 'done' && a.exitReason === OUTCOME_UNKNOWN) {
        a.status = 'running'
        a.exitReason = undefined
        this.#ended.delete(a)
      }

      a.model = row.model ?? a.model
      a.toolCount = Math.max(a.toolCount, row.tool_count ?? 0)
      a.steerable = row.accepting_steer ?? a.steerable
      a.startedAt = typeof row.started_at === 'number' ? row.started_at * 1000 : a.startedAt

      if (a.status === 'queued' || a.status === 'running') {
        a.status = 'running'

        if (!a.log && row.last_tool && a.tool !== row.last_tool) {
          a.tool = row.last_tool
          a.toolSince = { at: Date.now() }
        }
      }

      changed.add(a)
    }

    // A child that left the registry has finished; its log, when there is one, says how. Without
    // one (a remote gateway), so does a child never listed after a grace (it ended within a poll).
    // Neither says how it ended: the row waits on the delegation's completion (settle).
    for (const a of owners.keys()) {
      if (!isRunning(a) || present.has(a.id) || this.#readableLog(a)) {
        continue
      }

      if (!this.#listed.has(a.id)) {
        const unseen = (this.#unseen.get(a) ?? 0) + 1
        this.#unseen.set(a, unseen)

        if (unseen < GRACE_POLLS) {
          continue
        }
      }

      a.status = 'done'
      a.exitReason = OUTCOME_UNKNOWN
      a.duration = Date.now() - a.startedAt
      a.tool = undefined
      changed.add(a)
    }
  }

  /** The row `row` describes: by id, else a dispatch placeholder (`task-<i>`) of its delegation. */
  #find(owners: Map<Subagent, ToolCall>, row: ListRow): Subagent | undefined {
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
  #adopt(owners: Map<Subagent, ToolCall>, row: ListRow): Subagent | undefined {
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
      name: `${agentName(parent)}.${siblings + 1}`,
      parentId: parent.id,
      startedAt: Date.now(),
      status: 'running',
      tokens: 0,
      toolCount: 0
    }

    // After the parent's last descendant, so the card reads as a tree.
    let at = list.indexOf(parent) + 1

    while (at < list.length && (list[at]!.depth ?? 0) > (parent.depth ?? 0)) {
      at++
    }

    list.splice(at, 0, child)
    owners.set(child, call)

    return child
  }

  /**
   * A top-level child whose dispatch result the history dropped (a resumed session): a row on the
   * newest result-less delegate_task call whose task `sa-<i>-` asked for its goal, its log found
   * through the delegation's manifest (else read with `subagent.tail`).
   */
  async #attach(owners: Map<Subagent, ToolCall>, row: ListRow): Promise<Subagent | undefined> {
    const index = taskIndex(row)
    const goal = row.goal?.trim()

    if ((row.depth ?? 0) !== 0 || index === undefined || !goal) {
      return undefined
    }

    const call = this.#host.transcript
      .delegations()
      .findLast(c => c.result === undefined && taskGoals(c)[index] === goal && !c.subagents?.some(a => !a.depth && a.index === index))

    if (!call) {
      return undefined
    }

    const a: Subagent = {
      calls: 0,
      delegationId: row.delegation_id ?? undefined,
      depth: 0,
      goal: row.goal ?? goal,
      id: row.subagent_id,
      index,
      key: `p${index}`,
      logPath: row.delegation_id ? await manifestLog(row.delegation_id, index) : undefined,
      startedAt: Date.now(),
      status: 'running',
      tokens: 0,
      toolCount: 0
    }
    const list = (call.subagents ??= [])

    list.push(a)
    list.sort((x, y) => x.index - y.index || (x.depth ?? 0) - (y.depth ?? 0))
    owners.set(a, call)

    return a
  }

  #readableLog(a: Subagent): boolean {
    return Boolean(a.logPath && !this.#unreadable.has(a.logPath))
  }

  /** Reads `a`'s log from disk (else its tail over the gateway); true when it changed. */
  async #readLog(a: Subagent, force = false): Promise<boolean> {
    let text: string | undefined

    if (this.#readableLog(a)) {
      try {
        const path = a.logPath!
        const { size } = await stat(path)

        if (!force && this.#sizes.get(path) === size) {
          return false
        }

        this.#sizes.set(path, size)
        const bytes = await readFile(path)
        text = bytes.subarray(Math.max(0, bytes.length - MAX_LOG_BYTES)).toString('utf8')
      } catch {
        this.#unreadable.add(a.logPath!)
      }
    }

    if (text === undefined && this.#listed.has(a.id) && this.#host.sid) {
      try {
        const r = await rpc(this.#host.gw, 'subagent.tail', {
          session_id: this.#host.sid,
          subagent_id: a.id
        })

        if (r?.available && typeof r.text === 'string') {
          text = r.truncated ? mergeTail(this.#tails.get(a.id) ?? '', r.text) : r.text
          this.#tails.set(a.id, text)
        }
      } catch {
        text = undefined
      }
    }

    if (text === undefined) {
      return false
    }

    applyLog(a, parseLiveLog(text))

    return true
  }

  #touch(a: Subagent) {
    const call = this.#owners().get(a)

    if (call) {
      this.#host.transcript.touchCall(call)
    }

    if (!isRunning(a) && !this.#ended.has(a)) {
      this.#ended.add(a)
      this.#host.agentEnded?.()
    }
  }

  /** Each agent with the delegate_task call whose card shows it. */
  #owners(): Map<Subagent, ToolCall> {
    const owners = new Map<Subagent, ToolCall>()

    for (const call of this.#host.transcript.delegations()) {
      for (const a of call.subagents ?? []) {
        owners.set(a, call)
      }
    }

    return owners
  }
}

/**
 * Tail `tail` (a log's last bytes, maybe cut mid-line) appended to the log text read so far: the
 * part past where the two overlap. With no overlap (the log grew past a tail between reads), the
 * gap stays and the tail's cut first line is dropped.
 */
export function mergeTail(seen: string, tail: string): string {
  const lines = seen.split(/(?<=\n)/)
  let merged: string | undefined

  // The overlap ends with the last lines read: the longest such run (up to 4 lines) the tail holds.
  for (let n = Math.min(4, lines.length); n > 0 && merged === undefined; n--) {
    const anchor = lines.slice(-n).join('')
    const at = tail.indexOf(anchor)

    if (at >= 0) {
      merged = seen + tail.slice(at + anchor.length)
    }
  }

  merged ??= seen + (seen && !seen.endsWith('\n') ? '\n' : '') + tail.slice(tail.indexOf('\n') + 1)

  return merged.length > MAX_LOG_BYTES ? merged.slice(merged.indexOf('\n', merged.length - MAX_LOG_BYTES) + 1) : merged
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

  const [, kind, delegationId, task] = head as unknown as [string, string, string, string | undefined]
  const outcomes = new Map<number, string>()

  if (kind === 'BATCH COMPLETE') {
    for (const m of text.matchAll(/^--- \S+ TASK (\d+)\/\d+.*\(status=([^,)\s]+)/gm)) {
      outcomes.set(Number(m[1]) - 1, m[2]!)
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

/** A completion's task status as a row status; undefined for one that says nothing (`?`). */
function endedStatus(status: string): Subagent['status'] | undefined {
  if (status === '?') {
    return undefined
  }

  if (status === 'completed' || status === 'success' || status === 'unknown') {
    return 'done'
  }

  return status === 'interrupted' || status === 'cancelled' ? 'cancelled' : 'failed'
}

/** The task index a top-level child's id names (`sa-<i>-…`, tools/delegate_tool.py). */
function taskIndex(row: ListRow): number | undefined {
  const index = Number(/^sa-(\d+)-/.exec(row.subagent_id ?? '')?.[1])

  return Number.isInteger(index) ? index : undefined
}

/** The goals a delegate_task call asked for, by task index: its `tasks`, else its one `goal`. */
function taskGoals(call: ToolCall): string[] {
  let tasks = call.args.tasks

  if (typeof tasks === 'string') {
    try {
      tasks = JSON.parse(tasks)
    } catch {
      tasks = undefined
    }
  }

  if (Array.isArray(tasks) && tasks.length) {
    return tasks.map(t => {
      const goal = record(t)?.goal

      return typeof goal === 'string' ? goal.trim() : ''
    })
  }

  return typeof call.args.goal === 'string' ? [call.args.goal.trim()] : []
}

/**
 * Task `index`'s log path from its delegation's manifest.json, under this machine's Hermes home
 * (tools/delegation_live_log.py live_transcript_root: a populated legacy `delegation_cache/` first).
 */
async function manifestLog(delegationId: string, index: number, env = process.env): Promise<string | undefined> {
  if (!/^[\w-]+$/.test(delegationId)) {
    return undefined
  }

  const home = env.HERMES_HOME || join(homedir(), '.hermes')

  for (const root of [join(home, 'delegation_cache', 'live'), join(home, 'cache', 'delegation', 'live')]) {
    try {
      const text = await readFile(join(root, delegationId, 'manifest.json'), 'utf8')
      const tasks = record(text.replace(/^\uFEFF/, ''))?.tasks
      const log = Array.isArray(tasks) ? record(tasks.find(t => record(t)?.index === index))?.log : undefined

      if (typeof log === 'string' && log) {
        return log
      }
    } catch {
      // No manifest under this root.
    }
  }

  return undefined
}

/** Folds a parsed log into its row: timeline, current tool, counts and, once it ended, the outcome. */
export function applyLog(a: Subagent, log: LiveLog) {
  a.log = log
  const tools = log.entries.filter(e => e.kind === 'tool').length
  a.toolCount = Math.max(a.toolCount, tools)

  if (log.status) {
    a.status = log.status === 'completed' ? 'done' : log.status === 'interrupted' ? 'cancelled' : 'failed'
    a.summary = log.summary ?? a.summary
    a.duration = log.duration !== undefined ? Math.round(log.duration * 1000) : a.duration
    a.exitReason = log.exitReason ?? log.error ?? a.exitReason
    a.tool = undefined

    return
  }

  if (log.entries.length && a.status === 'queued') {
    a.status = 'running'
  }

  const now = runningTool(log)

  if (!now) {
    a.tool = undefined

    return
  }

  const since = clockToMs(now.at)

  if (a.tool !== now.name || a.toolSince?.at !== since) {
    a.tool = now.name
    a.toolPreview = now.args || undefined
    a.toolSince = { at: since }
  }
}
