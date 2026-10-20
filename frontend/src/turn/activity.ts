// What the session is doing, as the working line shows it: the busy state (a turn runs, or a
// prompt's `{!cmd}`s do) and a compaction. Activity is their one owner. Each write replaces the
// busy object and never edits it, and a relabel keeps its `since`, so the line's age runs on. The
// label is last-write-wins: 'Stopping…' stays only until the stream's next label.
//
// The work that puts a row up (a send, its `{!cmd}`s) holds a ticket for it, and its late answer
// ends the row only while the ticket is current. The gateway's turn takes the row over when it
// starts, so a send's timeout or an expansion that ends after message.start leaves the turn's row.

import { Epoch, type Ticket } from '../core/epoch.js'

/** The working row while a turn runs (or a prompt's `{!cmd}`s do). Replaced on each write, never edited. */
export interface Busy {
  readonly startedAt: number
  /** Owner of the working row's timer age; kept by a relabel, new per turn. */
  readonly since: object
  readonly label: string
}

/** A compaction (Hermes' own, or /compress): its row's age, and whether /compress asked for it. */
export type CompactionPhase =
  | { readonly kind: 'none' }
  | { readonly kind: 'running'; readonly since: object; readonly startedAt: number; readonly manual: boolean }

/** A compaction that runs. */
export type Compacting = Extract<CompactionPhase, { kind: 'running' }>

const NO_COMPACTION: CompactionPhase = { kind: 'none' }

/** The busy state and the compaction phase, written only through these methods. */
export class Activity {
  #busy: Busy | null = null
  #compaction: CompactionPhase = NO_COMPACTION
  /** Who may end the row: each new row, and the turn taking one over, ends the last owner's tickets. */
  readonly #owner = new Epoch()

  /** The working row; null when no turn (or expansion) runs. */
  get busy(): Busy | null {
    return this.#busy
  }

  /** Sets the busy state as given (a resumed session's, or one a test arranges); no earlier ticket ends it. */
  set(busy: Busy | null) {
    this.#busy = busy
    this.#owner.next()
  }

  /** A new working row labelled `label`, with an age of its own; the ticket ends it (endBusy). */
  startBusy(label: string, now = Date.now()): Ticket {
    this.#busy = { label, since: {}, startedAt: now }

    return this.#owner.next()
  }

  /**
   * The gateway's turn started (message.start). A row already up (a send's, or its `{!cmd}`s')
   * keeps its label and age, but the work that put it up can no longer end it; with none up, a
   * 'Working…' row of its own.
   */
  turnStarted(now = Date.now()) {
    this.#busy ??= { label: 'Working…', since: {}, startedAt: now }
    this.#owner.next()
  }

  /**
   * Relabels the working row, keeping its age. An empty label, or none running, changes nothing.
   * The stream's labels wait while the context is compacted; `status`: a label of the user's or
   * a status line's own (the interrupt's 'Stopping…', a retry), which shows then too.
   */
  relabel(label: string, { status = false }: { status?: boolean } = {}) {
    if (this.#busy && label && (status || this.#compaction.kind === 'none')) {
      this.#busy = { ...this.#busy, label }
    }
  }

  /**
   * No turn runs now. With `ticket` (a send's, an expansion's), only while that work still owns
   * the row; without one, whatever runs (the gateway said the turn ended, or went away).
   */
  endBusy(ticket?: Ticket) {
    if (ticket && !ticket.isCurrent()) {
      return
    }

    this.#busy = null
    this.#owner.next()
  }

  /** The compaction phase. */
  get compaction(): CompactionPhase {
    return this.#compaction
  }

  /** The running compaction, or undefined. */
  get compacting(): Compacting | undefined {
    return this.#compaction.kind === 'running' ? this.#compaction : undefined
  }

  /** A compaction started; one already running keeps its age (a /compress and its own status edge). */
  startCompaction({ manual }: { manual: boolean }, now = Date.now()) {
    if (this.#compaction.kind === 'none') {
      this.#compaction = { kind: 'running', manual, since: {}, startedAt: now }
    }
  }

  /** No compaction runs now. */
  endCompaction() {
    this.#compaction = NO_COMPACTION
  }
}
