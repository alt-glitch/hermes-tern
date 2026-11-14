// Live subagent state for the Task cards, the agents pill and the hub. The shared gateway streams
// `subagent.*` events on the session (gateway/local_viewer_events.py): apply() folds each into its
// row, and this store is the only writer of the rows. `subagent.list` (the owner's live registry:
// status, model, tool count, steerability) fills the gaps: once after an adopt or a reconnect,
// when events sent meanwhile are lost, and while a running row has heard no event. A resumed
// session's history drops the dispatch result, so its still-running children are found by that
// probe and attached to the delegate_task call that asked for their goals. The one agent the hub
// shows has its stored transcript read (`session.transcript`, agents/transcript.ts) for its
// timeline. The rows and how each source folds into them are rows.ts's; this reads and polls.

import type { SubagentEventPayload } from '@hermes/shared/gateway-events'
import type { GatewayClient } from '@hermes/shared/gateway-client'

import type { Ticket } from '../core/epoch.js'
import type { LiveSessionId } from '../core/ids.js'
import { Poller } from '../core/poller.js'
import type { Subagent, ToolCall } from '../model.js'
import type { Transcript } from '../transcript/store.js'
import { record } from '../wire/json.js'
import { rpc } from '../wire/rpc.js'

import {
  applyListRow,
  applyOutcome,
  askingCall,
  attachRow,
  completionOutcomes,
  dispatchOf,
  dispatchRows,
  endReported,
  endUnseen,
  findRow,
  foldEvent,
  isRunning,
  type ListRow,
  OUTCOME_UNKNOWN,
  nestedChild,
  type Owners,
  ownersOf,
  type SubagentEventType
} from './rows.js'
import { stepsOf, SubagentTranscript } from './transcript.js'

/** What the store reaches of the app. */
export interface AgentsHost {
  readonly gw: Pick<GatewayClient, 'request'>
  /** The open session's runtime id. */
  readonly sid: LiveSessionId | null
  readonly transcript: Transcript
  changed(): void
  /** A subagent ended (the PRs it linked may be new). */
  agentEnded?(): void
  /** An agent the session spawned, seen running in this pane, has ended now: once per agent (its line in the transcript). */
  agentFinished?(a: Subagent): void
}

const POLL_MS = 1000
/** Polls a row no event reached may go unlisted before it counts as ended (it can finish inside the first one). */
const GRACE_POLLS = 3

export class Agents {
  readonly #host: AgentsHost
  /** The poll: while a row needs the list, and while the followed agent's transcript can grow. */
  readonly #poller = new Poller({
    cadence: () => (this.#needsList() || this.#followedGrows() ? POLL_MS : 'off'),
    run: ticket => this.#round(ticket)
  })
  /** The next round polls `subagent.list` even with nothing running (a resumed session's probe). */
  #probe = false
  readonly #tracked = new WeakSet<ToolCall>()
  /**
   * Rows a `subagent.*` event reached since the session was adopted: the events tell their state,
   * so the `subagent.list` poll is not needed for them.
   */
  #streamed = new WeakSet<Subagent>()
  /** Ids `subagent.list` reported: one that leaves the list has finished. */
  readonly #listed = new Set<string>()
  /** Polls each unlisted row no event reached has gone unseen. */
  readonly #unseen = new WeakMap<Subagent, number>()
  /** Rows whose end the host heard of. */
  readonly #ended = new WeakSet<Subagent>()
  /** Rows seen running in this pane: only their ends are news (a resumed history's are not). */
  readonly #seenRunning = new WeakSet<Subagent>()
  /** Rows whose end agentFinished told. */
  readonly #finished = new WeakSet<Subagent>()
  /** The agent the hub shows: its transcript is read while it can grow. */
  #followed: Subagent | undefined
  /** What each followed agent's transcript read gave, by subagent id. */
  readonly #transcripts = new Map<string, SubagentTranscript>()
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
   * Another session is shown (`sid`), or the same one again after a reconnect: events sent while
   * the pane was away are lost, so the next round probes `subagent.list`. For another session, what
   * the store learned of the last one's children goes, and a poll in flight for it drops its answer.
   */
  adopt(sid: LiveSessionId | null) {
    this.#streamed = new WeakSet()
    this.#probe = true

    if (!this.#poller.adopt(sid)) {
      return
    }

    this.#listed.clear()
    this.#transcripts.clear()
    this.#followed = undefined
  }

  /**
   * Takes over each dispatched delegate_task call not tracked yet, and polls while a row needs it.
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

    this.#watchEnds()

    if (bare) {
      // A probe during a round in flight runs right after it.
      this.#probe = true
      this.#poller.poke()
    } else if (this.#needsList()) {
      this.#poller.poke()
    }
  }

  /**
   * A `subagent.*` event, folded into the rows of the delegate_task call whose card shows its
   * subagent. A background delegation reports after its turn ended (maybe after newer turns
   * started), so that call is found by the row it already holds or by its delegation id first.
   */
  apply(type: SubagentEventType, event: SubagentEventPayload, at = Date.now()) {
    const call = this.#callOf(event)
    const listed = this.#needsList()

    if (call) {
      this.#host.transcript.mutateCall(call, c => this.#streamed.add(foldEvent(c, { at, event, type })))
      this.#watchEnds()
    }

    // A nested child started: the list poll starts for it.
    if (!listed && this.#needsList()) {
      this.#poller.poke()
    }
  }

  /**
   * The agent the hub shows (undefined when it closes). Its stored transcript is read now and
   * then every second while it can grow; one agent at a time.
   */
  follow(a: Subagent | undefined) {
    if (a === this.#followed) {
      return
    }

    this.#followed = a

    if (a) {
      this.#poller.poke()
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
   * tools/process_registry_notifications.py) to the rows whose end the owner did not report.
   */
  settle(text: string) {
    const done = completionOutcomes(text)

    if (!done) {
      return
    }

    let changed = false

    for (const a of this.all()) {
      const status = a.depth ? undefined : done.outcomes.get(a.index)

      if (a.delegationId !== done.delegationId || status === undefined || endReported(a)) {
        continue
      }

      if (!applyOutcome(a, status)) {
        continue
      }

      this.#touch(a)
      changed = true
    }

    if (changed) {
      this.#watchEnds()
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

  /**
   * A running row only `subagent.list` tells the state of: one no event reached, or a nested child
   * (the gateway forwards a nested child's start and end, not its tool calls).
   */
  #needsList(): boolean {
    return this.running().some(a => !this.#streamed.has(a) || Boolean(a.depth))
  }

  /** The followed agent's transcript may still grow (or was never read). */
  #followedGrows(): boolean {
    const a = this.#followed

    return Boolean(a && !this.#transcripts.get(a.id)?.finished)
  }

  /**
   * The delegate_task call whose card shows the event's subagent: the one holding its row (or its
   * parent's, for a nested child), else the one that dispatched its delegation, else the newest.
   */
  #callOf(event: SubagentEventPayload): ToolCall | undefined {
    const transcript = this.#host.transcript
    const shown = [...this.#owners()].find(([a]) => a.id === event.subagent_id || (event.parent_id && a.id === event.parent_id))
    const id = event.delegation_id

    return (
      shown?.[1] ??
      (id ? transcript.delegations().findLast(c => record(c.result)?.['delegation_id'] === id) : undefined) ??
      transcript.lastCall(c => c.name === 'delegate_task')
    )
  }

  /** One round: the list when a probe or a row needs it, then the followed agent's transcript. */
  async #round(ticket: Ticket) {
    const probe = this.#probe
    this.#probe = false
    const changed = new Set<Subagent>()

    if (probe || this.#needsList()) {
      await this.#poll(changed, ticket)
    }

    const a = this.#followed

    if (a && ticket.isCurrent() && (await this.#readTranscript(a))) {
      changed.add(a)
    }

    // Another session was adopted meanwhile: these rows are not its rows.
    if (!ticket.isCurrent()) {
      return
    }

    if (changed.size) {
      changed.forEach(x => this.#touch(x))
      this.#watchEnds()
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
      // A session the owner no longer holds live (or a worker it cannot project): the events still tell.
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
      const a = findRow(owners, row) ?? nestedChild(owners, row) ?? this.#attach(owners, row)

      if (!a) {
        continue
      }

      if (applyListRow(a, row)) {
        this.#ended.delete(a)
      }

      changed.add(a)
    }

    // A child that left the registry has finished; its `subagent.complete` says how. A row no
    // event reached ends when it leaves the list, or after a grace when it was never listed (it
    // ended within a poll). Nothing says how it ended: it waits on the delegation's completion (settle).
    for (const a of owners.keys()) {
      if (!isRunning(a) || present.has(a.id) || this.#streamed.has(a)) {
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

  /** A top-level child whose dispatch result the history dropped (a resumed session): a row on the call that asked for its goal. */
  #attach(owners: Owners, row: ListRow): Subagent | undefined {
    const asked = askingCall(this.#host.transcript.delegations(), row)

    return asked && attachRow(owners, asked.call, asked.index, row)
  }

  /** Reads the rows `a` stored since the last read into its timeline; true when they changed. */
  async #readTranscript(a: Subagent): Promise<boolean> {
    const sid = this.#host.sid

    // A dispatch placeholder (`task-<i>`) has no id the owner knows yet.
    if (!sid || a.id.startsWith('task-')) {
      return false
    }

    let t = this.#transcripts.get(a.id)

    if (!t) {
      t = new SubagentTranscript(this.#host.gw, sid, a.id)
      this.#transcripts.set(a.id, t)
    } else if (t.finished) {
      return false
    }

    try {
      if (!(await t.read())) {
        return false
      }
    } catch {
      // The next round reads again while the hub shows it.
      return false
    }

    a.steps = stepsOf(t.rows)

    return true
  }

  /** Marks the card showing `a` changed, and tells when it ended. */
  #touch(a: Subagent) {
    this.#host.transcript.touchCall(this.#owners().get(a))

    if (!isRunning(a) && !this.#ended.has(a)) {
      this.#ended.add(a)
      this.#host.agentEnded?.()
    }
  }

  /**
   * Notes each agent running now, and tells the host of each one seen running that has ended since:
   * the end of an agent this pane never saw run (a resumed history's) is old news. A row that left
   * the list with no word on how it ended waits for the delegation's completion (settle) to say.
   */
  #watchEnds() {
    for (const a of this.all()) {
      if (isRunning(a)) {
        this.#seenRunning.add(a)
      } else if (this.#seenRunning.has(a) && !this.#finished.has(a) && a.exitReason !== OUTCOME_UNKNOWN) {
        this.#finished.add(a)

        // The session's own agents only: a nested child's end is its parent's business.
        if (!a.depth) {
          this.#host.agentFinished?.(a)
        }
      }
    }
  }

  /** Each agent with the delegate_task call whose card shows it. */
  #owners(): Owners {
    return ownersOf(this.#host.transcript.delegations())
  }
}
