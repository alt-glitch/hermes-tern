// The shared gateway's prompt queue as this pane sees it. The authority keeps a durable FIFO
// of admitted prompts (`pending` on session.resume and on every session.info fanout, which
// the shared client maps to `pending_submissions`); a prompt entered while a turn runs is
// admitted into it at once (prompt.submit), so it survives a crash and every viewer sees it.
// Its user bubble waits until the authority starts it, so it lands after the reply it waited
// for. Ported from Ink's app/pendingBubbles.ts and hooks/useQueue.ts (server rows).

import type { PendingRow } from './wire/schemas.js'

/** What Enter does while a turn runs (`display.busy_input_mode`, read with `config.get {key:'busy'}`). */
export type BusyMode = 'interrupt' | 'queue' | 'steer'

/** A busy mode as the gateway reports it; anything else is the TUI default, `queue`. */
export function busyModeOf(raw: unknown): BusyMode {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''

  return v === 'interrupt' || v === 'steer' ? v : 'queue'
}

/** A prompt this pane admitted behind the turn: what its bubble shows, and what Edit restores. */
export interface OwnAdmission<T> {
  /** The submission id it was admitted under. */
  inputId: string
  /** The authority's id for it, once prompt.submit answered. */
  admissionId?: string
  /** The bubble's text (what was typed, before `{!cmd}`s ran). */
  display: string
  item: T
}

/** One queued row the dock shows: an admission still on its way, or a row of the FIFO. */
export interface ServerQueued<T> {
  text: string
  row?: PendingRow
  /** This pane's own admission (Edit and Steer act on it); absent for another viewer's row. */
  own?: OwnAdmission<T>
}

/** The FIFO's rows that still wait (Ink's isServerQueued). */
export const isServerQueued = (row: PendingRow) => row.status === 'queued' || row.status === 'unknown'

/** The shared gateway's queue for the shown session, and the bubbles its started rows owe. */
export class ServerQueue<T> {
  rows: PendingRow[] = []
  readonly #own: OwnAdmission<T>[] = []
  /** Input ids whose bubble this pane painted (an idle send, or a started admission). */
  readonly #shown = new Set<string>()
  /** Admissions seen queued and never started: a `cancelled` completion of one is not the turn's. */
  readonly #queuedOnly = new Set<string>()
  /** Input ids of own admissions the FIFO has listed. */
  readonly #listed = new Set<string>()

  /** Another session: its FIFO from the resume snapshot, and none of the last one's bookkeeping. */
  reset(rows: PendingRow[] | undefined) {
    this.#own.length = 0
    this.#shown.clear()
    this.#queuedOnly.clear()
    this.#listed.clear()
    this.rows = []
    this.update(rows)
  }

  /** A prompt about to be admitted behind the turn; its row shows at once. */
  admit(own: OwnAdmission<T>) {
    this.#own.push(own)
  }

  /** Forgets an own admission (refused, withdrawn, or back in the composer). */
  drop(own: OwnAdmission<T>) {
    const at = this.#own.indexOf(own)

    if (at >= 0) {
      this.#own.splice(at, 1)
    }
  }

  /** A prompt whose bubble this pane painted when it sent it. */
  shown(inputId: string) {
    this.#shown.add(inputId)
  }

  /**
   * Takes the FIFO from a session.info (or a reconnect's resume) and returns the bubbles owed,
   * in order: this pane's admissions that started, and another viewer's rows this pane saw move
   * from queued to started (a resume snapshot's started row is already in the replayed history).
   */
  update(rows: PendingRow[] | undefined): { text: string; own?: OwnAdmission<T> }[] {
    if (!rows) {
      return []
    }

    const was = new Set(this.rows.filter(r => r.status === 'queued').map(r => r.admission_id))
    const owed: { text: string; own?: OwnAdmission<T> }[] = []

    for (const row of rows) {
      if (row.status === 'queued') {
        this.#queuedOnly.add(row.admission_id)
      }

      if (row.status !== 'started') {
        continue
      }

      this.#queuedOnly.delete(row.admission_id)

      if (row.input_id && this.#shown.has(row.input_id)) {
        continue
      }

      const own = this.#own.find(o => o.inputId === row.input_id)

      if (own || was.has(row.admission_id)) {
        if (row.input_id) {
          this.#shown.add(row.input_id)
        }

        if (own) {
          this.drop(own)
        }

        owed.push({ own, text: own?.display ?? row.user })
      }
    }

    this.rows = rows
    // An own admission whose row left the FIFO without starting (cancelled elsewhere) is gone.
    const listed = new Set(rows.map(r => r.input_id))

    for (const own of [...this.#own]) {
      if (listed.has(own.inputId)) {
        this.#listed.add(own.inputId)
      } else if (this.#listed.has(own.inputId)) {
        this.drop(own)
      }
    }

    return owed
  }

  /** Withdrawn by this pane: its row's `cancelled` completion must not end the running turn. */
  withdrawn(admissionId: string) {
    this.#queuedOnly.add(admissionId)
  }

  /** A message.complete that only settles a queued row nobody started (prompt.cancel's), not the running turn. */
  settlesQueuedRow(payload: unknown): boolean {
    const p = (payload ?? {}) as { admission_id?: unknown; outcome?: unknown }

    return p.outcome === 'cancelled' && typeof p.admission_id === 'string' && this.#queuedOnly.has(p.admission_id)
  }

  /** The rows that still wait, oldest first: the FIFO's, then admissions it does not list yet. */
  queued(): ServerQueued<T>[] {
    const rows = this.rows.filter(isServerQueued).map(row => ({
      own: this.#own.find(o => o.inputId === row.input_id),
      row,
      text: row.user
    }))
    const listed = new Set(this.rows.map(r => r.input_id))

    return [
      ...rows.map(r => (r.own ? { ...r, text: r.own.display } : r)),
      ...this.#own.filter(o => !listed.has(o.inputId)).map(own => ({ own, text: own.display }))
    ]
  }
}
