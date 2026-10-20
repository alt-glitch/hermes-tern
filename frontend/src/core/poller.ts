// One poll loop for every store that reads on a timer (processes, subagents, PRs, connect cards, a
// watched subagent). A round runs one at a time: a poke during a round asks for one more right
// after it, so no poke is lost. When a round ends, the store's cadence says how long to wait for
// the next one, or 'off' to wait for a poke. Each round takes a ticket: `adopt` (another session)
// and `dispose` make it stale, so a round that awaited across a switch drops what it read.

import { Epoch, type Ticket } from './epoch.js'

/** What a store gives its poller. */
export interface PollerOptions {
  /** One round. It checks `ticket.isCurrent()` after each await, before it writes. */
  run(ticket: Ticket): Promise<void>
  /** How long after a round the next one runs; 'off': none until the next poke. */
  cadence(): number | 'off'
  /** A round threw. Unset: the error is thrown on (an unhandled rejection, which the app shows). */
  onError?(error: unknown): void
  /** The rounds a poke asked for are done, and the next one is scheduled. */
  settled?(): void
}

/** A single-flight poll loop with rerun, a cadence, watchers and a ticket per session. */
export class Poller {
  readonly #options: PollerOptions
  readonly #epoch = new Epoch()
  #timer: NodeJS.Timeout | undefined
  #running = false
  #again = false
  #watchers = 0
  #key: unknown
  #disposed = false

  constructor(options: PollerOptions) {
    this.#options = options
  }

  /** A round is in flight. */
  get running(): boolean {
    return this.#running
  }

  /** A `watch()` has not been released (an open sheet wants the fast cadence). */
  get watched(): boolean {
    return this.#watchers > 0
  }

  /** A ticket for the present session: for reads outside a round (a sheet opening on one row). */
  ticket(): Ticket {
    return this.#epoch.current()
  }

  /** Runs a round now, or one more right after the round in flight. */
  poke() {
    if (this.#disposed) {
      return
    }

    clearTimeout(this.#timer)
    this.#timer = undefined

    if (this.#running) {
      this.#again = true

      return
    }

    void this.#loop()
  }

  /** Counts as watched (see `watched`) until the returned release runs; pokes now. */
  watch(): () => void {
    this.#watchers++
    this.poke()
    let released = false

    return () => {
      if (!released) {
        released = true
        this.#watchers--
      }
    }
  }

  /**
   * Another session (`key`): the round in flight goes stale and its signal aborts; the next round
   * reads for the new one. False, with nothing changed, when `key` is the one adopted last.
   */
  adopt(key: unknown): boolean {
    if (Object.is(key, this.#key)) {
      return false
    }

    this.#key = key
    this.#epoch.next()

    return true
  }

  /** Stops polling for good: no round runs again, and the one in flight goes stale. */
  dispose() {
    this.#disposed = true
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#epoch.next()
  }

  async #loop() {
    this.#running = true

    try {
      do {
        this.#again = false
        await this.#round()
      } while (this.#again && !this.#disposed)
    } finally {
      this.#running = false
      this.#schedule()
      this.#options.settled?.()
    }
  }

  async #round() {
    try {
      await this.#options.run(this.#epoch.current())
    } catch (error) {
      if (!this.#options.onError) {
        throw error
      }

      this.#options.onError(error)
    }
  }

  #schedule() {
    clearTimeout(this.#timer)
    this.#timer = undefined
    const ms = this.#disposed ? 'off' : this.#options.cadence()

    if (ms !== 'off') {
      this.#timer = setTimeout(() => this.poke(), ms)
    }
  }
}
