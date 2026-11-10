// One subagent's stored transcript, read from the gateway: `session.transcript` with the parent
// session's id and the child's `subagent_id` (gateway/session_transcript_subagent.py). It serves the
// child's rows while the child runs and after it ends. Rows come oldest first; the oldest-order
// cursor is the poll: an empty page means caught up, `reset` means start over, and `running` says
// whether more can come. The agents hub and the subagent pane each read only the agent shown.

import type { StoredTranscriptRow } from '@hermes/shared/gateway-events'
import { jsonRpcErrorReason } from '@hermes/shared/json-rpc-channel'

import { optional } from '../core/assert.js'
import type { Subagent } from '../model.js'
import { type Requester, rpc } from '../wire/rpc.js'

/** Rows asked for per page. */
const PAGE_ROWS = 200
/** Pages one read takes at most, so a long transcript draws while the rest loads. */
const MAX_PAGES = 5

/** What the stored rows read so far of one subagent. */
export class SubagentTranscript {
  rows: StoredTranscriptRow[] = []
  /** The child runs (or waits for a slot), as the last page said; undefined before the first read. */
  running: boolean | undefined
  /** The gateway found the child's stored session; false for a queued child or one it does not know. */
  available = false
  readonly #gw: Requester
  readonly #sid: string
  readonly #subagent: string
  #cursor: string | null = null
  #caughtUp = false
  #published = false

  /** The transcript of subagent `subagent` of session `sid` (its runtime id), read over `gw`. */
  constructor(gw: Requester, sid: string, subagent: string) {
    this.#gw = gw
    this.#sid = sid
    this.#subagent = subagent
  }

  /** The child ended and every row it wrote is read: no read can bring more. */
  get finished(): boolean {
    return this.running === false && (this.#caughtUp || !this.available)
  }

  /** Reads the rows written since the last read; true when the rows changed. */
  async read(): Promise<boolean> {
    let changed = false

    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await this.#page()
      this.running = page.running ?? false
      this.available = page.available ?? false

      if (page.reset) {
        changed ||= this.rows.length > 0 || page.rows.length > 0
        this.rows = [...page.rows]
      } else {
        changed ||= page.rows.length > 0
        this.rows.push(...page.rows)
      }

      this.#cursor = page.next_cursor ?? this.#cursor
      this.#caughtUp = page.rows.length === 0

      if (this.#caughtUp || !page.next_cursor) {
        break
      }
    }

    return changed
  }

  async #page() {
    const params = {
      limit: PAGE_ROWS,
      order: 'oldest' as const,
      session_id: this.#sid,
      subagent_id: this.#subagent,
      ...optional('cursor', this.#cursor ?? undefined)
    }

    try {
      return await rpc(this.#gw, 'session.transcript', params)
    } catch (error) {
      if (this.#published || jsonRpcErrorReason(error) !== 'not_found') {
        throw error
      }

      // The parent is not live on the gateway (a pane that did not attach it, after a gateway
      // restart). A plain read of it publishes its route without attaching, and then a child read
      // is allowed (website/docs/developer-guide/gateway-local-sessions.md).
      this.#published = true
      await rpc(this.#gw, 'session.transcript', { limit: 1, session_id: this.#sid })

      return rpc(this.#gw, 'session.transcript', params)
    }
  }
}

/** One step of an agent's timeline in the hub. `at` is epoch milliseconds, when the row has a time. */
export type AgentStep =
  | { kind: 'kickoff' | 'think' | 'assistant' | 'note'; at: number | undefined; text: string }
  | {
      kind: 'tool'
      at: number | undefined
      name: string
      /** The gateway's one-line preview of the call's arguments. */
      args: string
      running: boolean
    }

const ms = (seconds: number | null | undefined) => (seconds === null || seconds === undefined ? undefined : Math.round(seconds * 1000))

/**
 * The timeline steps of a child's stored rows: its task, each reasoning and answer, each finished
 * tool call and any other note. A row's time is when it was stored: a call and its result are
 * stored together when the call returns, so a call's own duration is not in the rows.
 */
export function stepsOf(rows: readonly StoredTranscriptRow[]): AgentStep[] {
  const steps: AgentStep[] = []

  for (const row of rows) {
    const at = ms(row.timestamp)
    const text = row.text?.trim() ?? ''

    if (row.row_kind === 'message' && row.role === 'tool') {
      steps.push({ args: row.context ?? '', at, kind: 'tool', name: row.name ?? 'tool', running: false })
    } else if (row.row_kind === 'message' && row.role === 'assistant') {
      if (row.reasoning?.trim()) {
        steps.push({ at, kind: 'think', text: row.reasoning.trim() })
      }

      if (text) {
        steps.push({ at, kind: 'assistant', text })
      }
    } else if (row.row_kind === 'message' && row.role === 'user' && !steps.some(s => s.kind === 'kickoff')) {
      steps.push({ at, kind: 'kickoff', text })
    } else if (text) {
      steps.push({ at, kind: 'note', text })
    }
  }

  return steps
}

/**
 * `a`'s timeline: its stored steps, then the tool it runs now when its stored rows do not hold
 * that call yet (a call is stored with its result; the owner counts it when it starts).
 */
export function agentSteps(a: Subagent): AgentStep[] {
  const steps = a.steps ?? []
  const stored = steps.filter(s => s.kind === 'tool').length

  return a.status === 'running' && a.tool && a.toolCount > stored
    ? [...steps, { args: a.toolPreview ?? '', at: a.toolSince?.at, kind: 'tool', name: a.tool, running: true }]
    : steps
}
