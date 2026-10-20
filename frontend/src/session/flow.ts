// Session switching rules: which gateway traffic belongs to the shown session,
// which new/resume result is still wanted, and the busy state a resumed
// session starts in (it may be mid-turn). Traffic that names a session goes by
// the phase the pane is in: a session shown, one being switched to, or none.

import type { SessionResumeResult } from '@hermes/shared/gateway-events'

import { Epoch, type Ticket } from '../core/epoch.js'
import type { LiveSessionId } from '../core/ids.js'
import type { Busy } from '../turn/activity.js'

/** What to do with a server request or an event: show it, keep it until the switch in flight lands, or drop it. */
export type RequestRoute = 'show' | 'hold' | 'drop'

/**
 * Session switches (new, resume, reattach) in flight. Each `begin` supersedes
 * the last, so a slow earlier result never replaces a later choice; while one
 * is pending, prompts and the queue wait for the session it adopts.
 */
export class Switches {
  /** One generation per switch: a switch's token is the generation its `begin` started. */
  readonly #epoch = new Epoch()
  #pending = false

  /** Whether a switch is in flight. */
  get pending(): boolean {
    return this.#pending
  }

  /** Bumped by every `begin`: read before an await, it tells whether a switch began since. */
  get generation(): number {
    return this.#epoch.generation
  }

  /** Starts a switch and returns its token; earlier tokens go stale. */
  begin(): number {
    this.#pending = true
    this.#epoch.next()

    return this.#epoch.generation
  }

  /** Whether switch `token` is still the latest one (its result may apply). */
  current(token: number): boolean {
    return token === this.#epoch.generation
  }

  /** A ticket that goes stale once another switch begins (its signal aborts then). */
  since(): Ticket {
    return this.#epoch.current()
  }

  /** Ends switch `token` (adopted or failed); a superseded token leaves the newer switch pending. */
  end(token: number) {
    if (this.current(token)) {
      this.#pending = false
    }
  }

  /**
   * Routes a server request for `sessionId` while `active` is shown (null: none yet, or the
   * gateway is down): another session's request waits while a switch is in flight (it may be the
   * one being adopted) and is dropped otherwise.
   */
  route(active: LiveSessionId | null, sessionId: string | undefined): RequestRoute {
    if (!sessionId || sessionId === active) {
      return 'show'
    }

    return this.#pending ? 'hold' : 'drop'
  }
}

/**
 * Routes a gateway event while `active` is shown: session-less and `gateway.*` events are global,
 * the rest must name it. With no session shown, one that names a session waits while a switch is
 * in flight (it may be the adopted session's, racing its snapshot) and drops otherwise; while a
 * session is shown, another session's drops (a resume's own frames wait in the client's hold).
 */
export function routeEvent(active: LiveSessionId | null, switching: boolean, ev: { type: string; session_id?: string }): RequestRoute {
  if (!ev.session_id || ev.session_id === active || ev.type.startsWith('gateway.')) {
    return 'show'
  }

  return !active && switching ? 'hold' : 'drop'
}

/** The busy state a resumed session starts in: running (or waiting on the user) means a turn is live. */
export function busyFrom(
  r: Pick<SessionResumeResult, 'running' | 'status' | 'turn_started_at'>,
  now = Date.now()
): Busy | null {
  if (!r.running && r.status !== 'working' && r.status !== 'waiting') {
    return null
  }

  return { label: 'Working…', since: {}, startedAt: r.turn_started_at ? r.turn_started_at * 1000 : now }
}
