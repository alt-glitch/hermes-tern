// Live subagent state for the Task cards, the agents pill and the hub. The shared gateway does not
// forward `subagent.*` events to viewers, so this reads what it does serve: `subagent.list` (the
// owner's live registry: status, model, tool count, steerability) and each child's live
// transcript log (tools/delegation_live_log.py), whose path the dispatch result names. The log
// outlives the child, so a finished agent keeps its timeline and final status. Where a gateway
// does send `subagent.*` events, apply() folds them into the same rows: this store is the only
// writer of the rows. A resumed
// session's history drops the dispatch result, so its still-running children are found by one
// `subagent.list` probe and attached to the delegate_task call that asked for their goals. The
// rows and how each source folds into them are rows.ts's; this reads and polls.

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { SubagentEventPayload } from '@hermes/shared/gateway-events'
import type { GatewayClient } from '@tui/gatewayClient.js'

import type { Ticket } from '../core/epoch.js'
import { errorCode } from '../core/errors.js'
import type { LiveSessionId } from '../core/ids.js'
import { Poller } from '../core/poller.js'
import type { Subagent, ToolCall } from '../model.js'
import type { Transcript } from '../transcript.js'
import { record } from '../wire/json.js'
import { rpc } from '../wire/rpc.js'

import { parseLiveLog } from './liveLog.js'
import {
  applyListRow,
  applyLog,
  applyOutcome,
  askingCall,
  attachRow,
  completionOutcomes,
  dispatchOf,
  dispatchRows,
  endUnseen,
  findRow,
  foldEvent,
  isRunning,
  type ListRow,
  MAX_LOG_BYTES,
  mergeTail,
  nestedChild,
  type Owners,
  ownersOf,
  type SubagentEventType
} from './rows.js'

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

const POLL_MS = 1000
/** Polls a child with no log this process can read may go unlisted before it counts as ended (it can finish inside the first one). */
const GRACE_POLLS = 3
/**
 * Reads that found no log file before the store stops looking for it: a child may not have
 * written it yet, but a gateway on another machine writes it where this process never sees it.
 */
const MISSING_READS = 3

/** What one read of a child's log file gave. */
export type LogRead =
  /** The log's text (its last `MAX_LOG_BYTES`) and its size. */
  | { kind: 'ok'; text: string; size: number }
  /** It has the size it had at the last read: nothing new. */
  | { kind: 'same' }
  /** No such file (ENOENT): the child has not written it yet, or it is on another machine. */
  | { kind: 'notYet' }
  /** It is there and this process may not read it (EACCES, EPERM), or the read failed otherwise. */
  | { kind: 'unreadable'; error: unknown }

/** Reads the log at `path`, unless it still has size `last` (undefined: read it whatever its size). */
export async function readLogFile(path: string, last: number | undefined): Promise<LogRead> {
  try {
    const { size } = await stat(path)

    if (last === size) {
      return { kind: 'same' }
    }

    const bytes = await readFile(path)

    return { kind: 'ok', size, text: bytes.subarray(Math.max(0, bytes.length - MAX_LOG_BYTES)).toString('utf8') }
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'notYet' } : { error, kind: 'unreadable' }
  }
}

export class Agents {
  readonly #host: AgentsHost
  /** The poll: every second while an agent runs, and a probe for a resumed session's children. */
  readonly #poller = new Poller({
    cadence: () => (this.running().length ? POLL_MS : 'off'),
    run: ticket => this.#round(ticket)
  })
  /** The next round polls even with nothing running (a resumed session's probe). */
  #probe = false
  readonly #tracked = new WeakSet<ToolCall>()
  /** Log sizes at the last read, by path; a log that did not grow is not read again. */
  readonly #sizes = new Map<string, number>()
  /** Logs this process cannot read (a gateway on another machine): `subagent.tail` instead. */
  readonly #unreadable = new Set<string>()
  /** Reads in a row that found no log file, by path (see MISSING_READS). */
  readonly #missing = new Map<string, number>()
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
   * Another session is shown (`sid`): what the store learned of the last one's children (listed
   * ids, log sizes, tails, unreadable logs) goes, and a poll in flight for it drops its answer.
   */
  adopt(sid: LiveSessionId | null) {
    if (!this.#poller.adopt(sid)) {
      return
    }

    this.#listed.clear()
    this.#sizes.clear()
    this.#tails.clear()
    this.#unreadable.clear()
    this.#missing.clear()
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
      } else if (call.result === undefined && call.outcome.kind !== 'running' && !call.subagents?.length) {
        bare = true
      }
    }

    if (this.running().length) {
      this.#poller.poke()
    } else if (bare) {
      // A probe during a round in flight runs right after it.
      this.#probe = true
      this.#poller.poke()
    }
  }

  /**
   * A `subagent.*` event, where the gateway sends them, folded into the rows of the delegate_task
   * call that dispatched it. A background delegation reports after its turn ended (maybe after
   * newer turns started), so its call is found by its delegation id first; else it is the newest
   * delegate_task call of the live (else the last) turn.
   */
  apply(type: SubagentEventType, event: SubagentEventPayload, at = Date.now()) {
    const transcript = this.#host.transcript
    const id = event.delegation_id
    const call =
      (id ? transcript.delegations().findLast(c => record(c.result)?.['delegation_id'] === id) : undefined) ??
      transcript.lastCall(c => c.name === 'delegate_task')

    if (call) {
      transcript.mutateCall(call, c => foldEvent(c, { at, event, type }))
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

      if (!applyOutcome(a, status)) {
        continue
      }

      this.#touch(a)
      changed = true
    }

    if (changed) {
      this.#host.changed()
    }
  }

  /** Reads `a`'s log now (the hub's timeline opening on it), whatever its state. */
  async refresh(a: Subagent) {
    if (await this.#readLog(a, this.#poller.ticket(), true)) {
      this.#touch(a)
      this.#host.changed()
    }
  }

  /** Stops the poll for good (the pane quits). */
  dispose() {
    this.#poller.dispose()
  }

  #track(call: ToolCall, at: number): boolean {
    const dispatch = dispatchOf(call.result)

    if (!dispatch) {
      return false
    }

    this.#host.transcript.mutateCall(call, c => dispatchRows((c.subagents ??= []), dispatch, at))

    return true
  }

  /** One poll and log read; a probe polls even with nothing running yet (a resumed session). */
  async #round(ticket: Ticket) {
    const probe = this.#probe
    this.#probe = false

    if (!probe && !this.running().length) {
      return
    }

    const changed = new Set<Subagent>()
    await this.#poll(changed, ticket)

    if (!ticket.isCurrent()) {
      return
    }

    const reads = await Promise.all(this.running().map(async a => ((await this.#readLog(a, ticket)) ? a : undefined)))

    // Another session was adopted meanwhile: these rows are not its rows.
    if (!ticket.isCurrent()) {
      return
    }

    reads.forEach(a => a && changed.add(a))

    if (changed.size) {
      changed.forEach(a => this.#touch(a))
      this.#host.changed()
    }
  }

  /** Folds `subagent.list` into the rows: new nested children, status, model, counts. */
  async #poll(changed: Set<Subagent>, ticket: Ticket) {
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

    if (!ticket.isCurrent()) {
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
      const a = findRow(owners, row) ?? nestedChild(owners, row) ?? (await this.#attach(owners, row, ticket))

      if (!ticket.isCurrent()) {
        return
      }

      if (!a) {
        continue
      }

      if (applyListRow(a, row)) {
        this.#ended.delete(a)
      }

      changed.add(a)
    }

    // A child that left the registry has finished; its log, when there is one, says how. Without
    // one (a remote gateway), so does a child never listed after a grace (it ended within a poll).
    // Neither says how it ended: the row waits on the delegation's completion (settle).
    for (const a of owners.keys()) {
      if (!isRunning(a) || present.has(a.id) || this.#logPath(a)) {
        continue
      }

      if (!this.#listed.has(a.id)) {
        const unseen = (this.#unseen.get(a) ?? 0) + 1
        this.#unseen.set(a, unseen)

        if (unseen < GRACE_POLLS) {
          continue
        }
      }

      endUnseen(a)
      changed.add(a)
    }
  }

  /**
   * A top-level child whose dispatch result the history dropped (a resumed session): a row on the
   * call that asked for its goal, its log found through the delegation's manifest (else read with
   * `subagent.tail`).
   */
  async #attach(owners: Owners, row: ListRow, ticket: Ticket): Promise<Subagent | undefined> {
    const asked = askingCall(this.#host.transcript.delegations(), row)

    if (!asked) {
      return undefined
    }

    const logPath = row.delegation_id ? await manifestLog(row.delegation_id, asked.index) : undefined

    return ticket.isCurrent() ? attachRow(owners, asked.call, asked.index, row, logPath) : undefined
  }

  /** `a`'s log path while this process may read it. */
  #logPath(a: Subagent): string | undefined {
    return a.logPath && !this.#unreadable.has(a.logPath) ? a.logPath : undefined
  }

  /** Reads `a`'s log from disk (else its tail over the gateway); true when it changed. */
  async #readLog(a: Subagent, ticket: Ticket, force = false): Promise<boolean> {
    let text: string | undefined
    const path = this.#logPath(a)

    if (path) {
      const read = await readLogFile(path, force ? undefined : this.#sizes.get(path))

      if (!ticket.isCurrent()) {
        return false
      }

      switch (read.kind) {
        case 'ok':
          this.#sizes.set(path, read.size)
          this.#missing.delete(path)
          text = read.text
          break

        case 'same':
          return false

        case 'notYet': {
          // Not written yet, or written on another machine: after a few reads, the tail it is.
          const misses = (this.#missing.get(path) ?? 0) + 1
          this.#missing.set(path, misses)

          if (misses >= MISSING_READS) {
            this.#unreadable.add(path)
          }

          break
        }

        case 'unreadable':
          this.#unreadable.add(path)
      }
    }

    const sid = this.#host.sid

    if (text === undefined && this.#listed.has(a.id) && sid) {
      try {
        const r = await rpc(this.#host.gw, 'subagent.tail', { session_id: sid, subagent_id: a.id })

        if (!ticket.isCurrent()) {
          return false
        }

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

  /** Marks the card showing `a` changed (#poll and #readLog changed its row), and tells when it ended. */
  #touch(a: Subagent) {
    this.#host.transcript.touchCall(this.#owners().get(a))

    if (!isRunning(a) && !this.#ended.has(a)) {
      this.#ended.add(a)
      this.#host.agentEnded?.()
    }
  }

  /** Each agent with the delegate_task call whose card shows it. */
  #owners(): Owners {
    return ownersOf(this.#host.transcript.delegations())
  }
}

/**
 * Task `index`'s log path from its delegation's manifest.json, under this machine's Hermes home
 * (tools/delegation_live_log.py live_transcript_root: a populated legacy `delegation_cache/` first).
 */
async function manifestLog(delegationId: string, index: number, env = process.env): Promise<string | undefined> {
  if (!/^[\w-]+$/.test(delegationId)) {
    return undefined
  }

  const home = env['HERMES_HOME'] || join(homedir(), '.hermes')

  for (const root of [join(home, 'delegation_cache', 'live'), join(home, 'cache', 'delegation', 'live')]) {
    try {
      const text = await readFile(join(root, delegationId, 'manifest.json'), 'utf8')
      const tasks = record(text.replace(/^\uFEFF/, ''))?.['tasks']
      const log = Array.isArray(tasks) ? record(tasks.find(t => record(t)?.['index'] === index))?.['log'] : undefined

      if (typeof log === 'string' && log) {
        return log
      }
    } catch {
      // No manifest under this root.
    }
  }

  return undefined
}
