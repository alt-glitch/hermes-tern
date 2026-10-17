// Live subagent state for the Task cards, the agents pill and the hub. The shared gateway does not
// forward `subagent.*` events to viewers, so this reads what it does serve: `subagent.list` (the
// owner's live registry: status, model, tool count, steerability) and each child's live
// transcript log (tools/delegation_live_log.py), whose path the dispatch result names. The log
// outlives the child, so a finished agent keeps its timeline and final status. Where a gateway
// does send `subagent.*` events, Transcript.subagent folds them into the same rows.

import { readFile, stat } from 'node:fs/promises'

import type { GatewayClient } from '@tui/gatewayClient.js'

import type { Subagent, ToolCall } from '../model.js'
import { record, type Transcript } from '../transcript.js'

import { clockToMs, parseLiveLog, runningTool, type LiveLog } from './liveLog.js'

/** What the store reaches of the app. */
export interface AgentsHost {
  readonly gw: Pick<GatewayClient, 'request'>
  readonly sid: string | null
  readonly transcript: Transcript
  changed(): void
}

/** One row of `subagent.list` (gateway/session_ancillary.py `_SUBAGENT_FIELDS`). */
interface ListRow {
  subagent_id?: string
  parent_id?: string | null
  depth?: number
  goal?: string
  delegation_id?: string
  model?: string | null
  started_at?: number
  status?: string
  tool_count?: number
  last_tool?: string | null
  accepting_steer?: boolean
}

const POLL_MS = 1000
/** Logs are compact (one capped line per event); a runaway one is read from its tail. */
const MAX_LOG_BYTES = 2 * 1024 * 1024
const ENDED = new Set(['cancelled', 'done', 'failed'])

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

  /** Takes over each dispatched delegate_task call not tracked yet, and polls while any agent runs. */
  scan(at = Date.now()) {
    for (const call of this.#host.transcript.delegations()) {
      if (!this.#tracked.has(call) && this.#track(call, at)) {
        this.#tracked.add(call)
      }
    }

    if (this.running().length) {
      this.#wake()
    }
  }

  /** Queues steering text into a running agent; the owner answers `queued` or `rejected`. */
  async steer(a: Subagent, text: string): Promise<boolean> {
    const r = await this.#host.gw.request<{ status?: string }>('subagent.steer', {
      session_id: this.#host.sid,
      subagent_id: a.id,
      text
    })

    return r?.status === 'queued'
  }

  /** Interrupts a running agent; its partial result still returns to the parent. */
  async stop(a: Subagent): Promise<boolean> {
    const r = await this.#host.gw.request<{ found?: boolean }>('subagent.interrupt', {
      session_id: this.#host.sid,
      subagent_id: a.id
    })

    return Boolean(r?.found)
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

  async #tick() {
    if (this.#ticking) {
      return
    }

    this.#ticking = true

    try {
      const live = this.running()

      if (!live.length) {
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
      rows = (await this.#host.gw.request<{ subagents?: ListRow[] }>('subagent.list', { session_id: sid }))?.subagents ?? []
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
      const a = this.#find(owners, row) ?? this.#adopt(owners, row)

      if (!a) {
        continue
      }

      a.id = id
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

    // A child that left the registry has finished; its log, when there is one, says how.
    for (const a of owners.keys()) {
      if (isRunning(a) && this.#listed.has(a.id) && !present.has(a.id) && !this.#readableLog(a)) {
        a.status = 'done'
        a.duration = Date.now() - a.startedAt
        a.tool = undefined
        changed.add(a)
      }
    }
  }

  /** The row `row` describes: by id, else a dispatch placeholder (`task-<i>`) of its delegation. */
  #find(owners: Map<Subagent, ToolCall>, row: ListRow): Subagent | undefined {
    const agents = [...owners.keys()]
    const byId = agents.find(a => a.id === row.subagent_id)

    if (byId) {
      return byId
    }

    const index = Number(/^sa-(\d+)-/.exec(row.subagent_id ?? '')?.[1])

    return (row.depth ?? 0) === 0 && Number.isInteger(index)
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
      delegationId: row.delegation_id,
      depth: (parent.depth ?? 0) + 1,
      goal: row.goal ?? '',
      id: row.subagent_id!,
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
        const r = await this.#host.gw.request<{ available?: boolean; text?: string }>('subagent.tail', {
          session_id: this.#host.sid,
          subagent_id: a.id
        })

        text = r?.available ? r.text : undefined
      } catch {
        text = undefined
      }
    }

    if (text === undefined) {
      return false
    }

    apply(a, parseLiveLog(text))

    return true
  }

  #touch(a: Subagent) {
    const call = this.#owners().get(a)

    if (call) {
      this.#host.transcript.touchCall(call)
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

/** Folds a parsed log into its row: timeline, current tool, counts and, once it ended, the outcome. */
function apply(a: Subagent, log: LiveLog) {
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
