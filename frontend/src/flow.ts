// Session switching rules: which gateway traffic belongs to the shown session,
// which new/resume result is still wanted, and the busy state a resumed
// session starts in (it may be mid-turn).

import type { SessionResumeResult } from '@hermes/shared/gateway-events'

/** The working row while a turn runs. */
export interface Busy {
  startedAt: number
  /** Owner of the working row's timer age; replaced per turn. */
  since: object
  label: string
}

/** What to do with a server request: show it, keep it until the switch in flight lands, or drop it. */
export type RequestRoute = 'show' | 'hold' | 'drop'

/**
 * Session switches (new, resume, reattach) in flight. Each `begin` supersedes
 * the last, so a slow earlier result never replaces a later choice; while one
 * is pending, prompts and the queue wait for the session it adopts.
 */
export class Switches {
  #generation = 0
  #pending = false

  /** Whether a switch is in flight. */
  get pending(): boolean {
    return this.#pending
  }

  /** Starts a switch and returns its token; earlier tokens go stale. */
  begin(): number {
    this.#pending = true

    return ++this.#generation
  }

  /** Whether switch `token` is still the latest one (its result may apply). */
  current(token: number): boolean {
    return token === this.#generation
  }

  /** Ends switch `token` (adopted or failed); a superseded token leaves the newer switch pending. */
  end(token: number) {
    if (this.current(token)) {
      this.#pending = false
    }
  }

  /**
   * Routes a server request for `sessionId` while `active` is shown: another
   * session's request waits while a switch is in flight (it may be the one
   * being adopted) and is dropped otherwise.
   */
  route(active: string | null, sessionId: string | undefined): RequestRoute {
    if (!sessionId || !active || sessionId === active) {
      return 'show'
    }

    return this.#pending ? 'hold' : 'drop'
  }
}

/**
 * Whether a gateway event belongs on screen while `active` is shown:
 * session-less and `gateway.*` events are global, the rest must name it.
 */
export function ownsEvent(active: string | null, ev: { type: string; session_id?: string }): boolean {
  return !ev.session_id || !active || ev.session_id === active || ev.type.startsWith('gateway.')
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
