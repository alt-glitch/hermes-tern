// A value shown for a moment, then gone: a Copy button that reads "Copied" after a click. One
// owner for its timer: a new value restarts it, and dispose() stops it with the view that shows it.

/** How long a Copy button reads Copied. */
export const FLASH_MS = 1500

/** A value that holds for FLASH_MS after each set, then clears; each change asks for a render. */
export class Flash<T> {
  readonly #changed: () => void
  readonly #ms: number
  #value: T | undefined
  #timer: NodeJS.Timeout | undefined

  constructor(changed: () => void, ms = FLASH_MS) {
    this.#changed = changed
    this.#ms = ms
  }

  /** The value shown now; undefined once its time is up. */
  get value(): T | undefined {
    return this.#value
  }

  /** Shows `value` now, for the flash's time from now. */
  set(value: T) {
    this.#value = value
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#value = undefined
      this.#changed()
    }, this.#ms)
    this.#changed()
  }

  /** Stops the timer (the view that shows it went away). */
  dispose() {
    clearTimeout(this.#timer)
  }
}
