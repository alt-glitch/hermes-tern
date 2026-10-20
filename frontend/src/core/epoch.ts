// One staleness primitive. Work that awaits (a reply, a timer, a poll) takes a ticket first; after
// each await it asks the ticket whether its result may still apply. An Epoch is a generation
// counter: `next()` ends the present generation, so every ticket taken before goes stale and its
// signal aborts.

/** Whether work begun earlier may still apply its result, checked after each await. */
export interface Ticket {
  /** True while the work this ticket guards may still apply its result. */
  isCurrent(): boolean
  /** Aborts once the ticket's generation ends, for work that can stop early. */
  readonly signal: AbortSignal
}

/** A generation counter that hands out tickets; `next()` makes every earlier ticket stale. */
export class Epoch {
  #generation = 0
  #controller = new AbortController()

  /** The present generation: 0 until the first `next()`. */
  get generation(): number {
    return this.#generation
  }

  /** A ticket for the present generation: current until the next `next()`. */
  current(): Ticket {
    const generation = this.#generation

    return { isCurrent: () => generation === this.#generation, signal: this.#controller.signal }
  }

  /** Ends the present generation (its tickets go stale, their signal aborts) and returns a ticket for the new one. */
  next(): Ticket {
    const ended = this.#controller
    this.#controller = new AbortController()
    this.#generation++
    ended.abort()

    return this.current()
  }
}
