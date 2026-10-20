// An owner for teardowns: timers, polls and subscriptions register here, and one dispose() at the
// end runs them all, the newest first (what was set up last comes down first).

/** Teardowns that run once, in reverse order of registration. */
export class Disposables {
  readonly #teardowns = new Set<() => void>()
  #disposed = false

  /** Whether dispose() ran. */
  get disposed(): boolean {
    return this.#disposed
  }

  /**
   * Runs `teardown` at dispose (at once when that already ran). The returned function drops it
   * unrun: the thing ended on its own.
   */
  add(teardown: () => void): () => void {
    if (this.#disposed) {
      teardown()

      return () => undefined
    }

    // A wrapper, so the same function added twice is two entries.
    const entry = () => teardown()
    this.#teardowns.add(entry)

    return () => void this.#teardowns.delete(entry)
  }

  /** setTimeout, cleared at dispose unless it fired first. */
  timeout(fn: () => void, ms: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      drop()
      fn()
    }, ms)
    const drop = this.add(() => clearTimeout(timer))

    return timer
  }

  /**
   * Runs every teardown once, the newest first. One that throws does not stop the rest; the first
   * error is thrown after all of them ran.
   */
  dispose() {
    if (this.#disposed) {
      return
    }

    this.#disposed = true
    const teardowns = [...this.#teardowns].reverse()
    this.#teardowns.clear()
    const errors: unknown[] = []

    for (const teardown of teardowns) {
      try {
        teardown()
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length) {
      throw errors[0]
    }
  }
}
