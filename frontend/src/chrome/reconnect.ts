// The gateway connection as the pane shows it: one transcript line when it drops, and the dock's
// redial line (`gateway.reconnecting`) until the next gateway.ready, re-rendered when each wait ends.

import type { NoticeEntry } from '../model.js'
import type { Reconnecting } from '../view/automation.js'

/** What the connection's state reaches of the app. */
export interface ReconnectHost {
  /** Asks for a render. */
  changed(): void
}

/** The line a dropped connection writes to the transcript. */
export interface LostLine {
  text: string
  tone: NoticeEntry['tone']
}

/** Whether the gateway is down, and its redial; one owner for the redial line's timer. */
export class Reconnect {
  readonly #host: ReconnectHost
  /** The connection is down until the next gateway.ready (its one line is shown). */
  #offline = false
  /** The gateway is being redialled until the next gateway.ready. */
  #redial: Reconnecting | undefined
  #timer: NodeJS.Timeout | undefined

  constructor(host: ReconnectHost) {
    this.#host = host
  }

  /** The redial the dock shows: which try, and when the next one starts. */
  get redial(): Reconnecting | undefined {
    return this.#redial
  }

  /**
   * The gateway exited: the line to show, once per outage (each failed redial exits again). An
   * attached gateway (and its turn) lives on, so its line says the pane reconnects.
   */
  lost(attached: boolean, code: number | null): LostLine | undefined {
    const first = !this.#offline
    this.#offline = true

    if (!first) {
      return undefined
    }

    return attached
      ? { text: 'Lost the connection to Hermes; reconnecting…', tone: 'warning' }
      : { text: `The agent backend exited${code === null ? '' : ` (${code})`}.`, tone: 'error' }
  }

  /** One line for the whole outage: each try replaces it, and re-renders when the wait ends. */
  redialing(attempt: number, delayMs: number) {
    clearTimeout(this.#timer)
    this.#redial = { attempt, dueAt: Date.now() + delayMs }
    this.#timer = setTimeout(() => this.#host.changed(), delayMs + 50)
    this.#timer.unref?.()
  }

  /** gateway.ready: the connection is up, and the redial line goes. */
  ready() {
    this.#offline = false
    clearTimeout(this.#timer)
    this.#redial = undefined
  }

  /** Stops the redial line's re-render. */
  dispose() {
    clearTimeout(this.#timer)
  }
}
