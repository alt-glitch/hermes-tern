// One render per event-loop turn: every state change asks for a render, and the asks before the
// next turn share one.

/** Coalesces render requests: the first `request()` schedules `render` for the next turn, the rest join it. */
export class RenderScheduler {
  readonly #render: () => void
  #scheduled = false

  constructor(render: () => void) {
    this.#render = render
  }

  /** Renders on the next turn of the event loop (setImmediate), once however often it is asked. */
  request() {
    if (this.#scheduled) {
      return
    }

    this.#scheduled = true
    setImmediate(() => {
      this.#scheduled = false
      this.#render()
    })
  }
}
