// The composer's undo history: the draft as it was before each edit, a typing burst joined into
// one step, and the steps undone kept for redo until the next edit.

/** The draft as one undo step holds it. */
export interface Snapshot {
  readonly text: string
  readonly cursor: number
}

/** Typing within this window joins one undo step. */
const UNDO_MERGE_MS = 800
/** The most steps kept; the oldest goes first. */
const MAX_STEPS = 200

/** One draft's undo and redo steps. */
export class UndoHistory {
  #undo: Snapshot[] = []
  #redo: Snapshot[] = []
  #lastEdit = 0

  /**
   * Saves `before`, the draft an edit is about to change, as a step; a typing burst (`merge`)
   * joins the step it began. Every edit drops the redo steps.
   */
  record(before: Snapshot, { merge }: { merge: boolean }) {
    const now = Date.now()

    if (!merge || now - this.#lastEdit > UNDO_MERGE_MS || !this.#undo.length) {
      this.#undo.push(before)

      if (this.#undo.length > MAX_STEPS) {
        this.#undo.shift()
      }
    }

    this.#lastEdit = merge ? now : 0
    this.#redo = []
  }

  /** The step before `current` (which redo gives back), or undefined when there is none. */
  undo(current: Snapshot): Snapshot | undefined {
    return this.#step(this.#undo, this.#redo, current)
  }

  /** The step undo left (`current` goes back on the undo steps), or undefined when there is none. */
  redo(current: Snapshot): Snapshot | undefined {
    return this.#step(this.#redo, this.#undo, current)
  }

  /** Ends the typing burst: the next keystroke starts a step of its own (the caret moved). */
  breakBurst() {
    this.#lastEdit = 0
  }

  /** Forgets every step (the draft was sent). */
  clear() {
    this.#undo = []
    this.#redo = []
  }

  /** Takes the newest step of `from`, and keeps `current` on `to`; a step ends the typing burst. */
  #step(from: Snapshot[], to: Snapshot[], current: Snapshot): Snapshot | undefined {
    const step = from.pop()

    if (!step) {
      return undefined
    }

    to.push(current)
    this.#lastEdit = 0

    return step
  }
}
