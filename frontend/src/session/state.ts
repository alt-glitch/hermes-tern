// The open session's state, in one place: its ids, the gateway's session.info and usage, and what
// Enter does while a turn runs. Each write asks for a render. Work that awaits on the shown session
// takes a ticket from here and checks it after each await.

import type { Usage } from '@hermes/shared/gateway-events'
import type { SessionInfo } from '@tui/types.js'

import type { SessionView } from '../app/ports.js'
import { Epoch, type Ticket } from '../core/epoch.js'
import { type LiveSessionId, NO_SESSION, type SessionIds } from '../core/ids.js'
import type { BusyMode } from '../turn/serverQueue.js'

/** A ticket for the session shown when it was taken (`sid`, null for none). */
export interface SessionTicket extends Ticket {
  /** The runtime id shown when the ticket was taken. */
  readonly sid: LiveSessionId | null
}

/**
 * A ticket for the session `shown()` names now: current while it names that session again. A
 * reattach that keeps the runtime id makes it current again; `signal` stays aborted once it ended.
 */
export function sessionTicket(shown: () => LiveSessionId | null, signal: AbortSignal): SessionTicket {
  const sid = shown()

  return { isCurrent: () => shown() === sid, signal, sid }
}

/** The open session: ids, info, usage and busy-input mode; every write asks for a render. */
export class SessionState implements SessionView {
  readonly #changed: () => void
  #ref: SessionIds = NO_SESSION
  #info: SessionInfo | null = null
  #usage: Usage | null = null
  #busyMode: BusyMode = 'queue'
  /** One generation per shown runtime id: a ticket's signal aborts once the view leaves its session. */
  readonly #shown = new Epoch()

  constructor(changed: () => void) {
    this.#changed = changed
  }

  /** The open session's ids: the runtime id requests name, and the stored id it is saved under. */
  get ref(): SessionIds {
    return this.#ref
  }

  set ref(ref: SessionIds) {
    if (ref.live !== this.#ref.live) {
      this.#shown.next()
    }

    this.#ref = ref
    this.#changed()
  }

  /** The gateway's session.info, merged; null before the first session. */
  get info(): SessionInfo | null {
    return this.#info
  }

  set info(info: SessionInfo | null) {
    this.#info = info
    this.#changed()
  }

  /** The session's token and context counters. */
  get usage(): Usage | null {
    return this.#usage
  }

  set usage(usage: Usage | null) {
    this.#usage = usage
    this.#changed()
  }

  /** What Enter does while a turn runs (`display.busy_input_mode`); queue until the gateway says. */
  get busyMode(): BusyMode {
    return this.#busyMode
  }

  set busyMode(mode: BusyMode) {
    this.#busyMode = mode
    this.#changed()
  }

  /** A ticket for the session shown now: current while the view shows it. */
  ticket(): SessionTicket {
    return sessionTicket(() => this.#ref.live, this.#shown.current().signal)
  }
}
