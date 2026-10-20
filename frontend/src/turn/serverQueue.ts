// The shared gateway's prompt queue as this pane sees it. The authority keeps a durable FIFO
// of admitted prompts (`pending` on session.resume and on every session.info fanout, which
// the shared client maps to `pending_submissions`); a prompt entered while a turn runs is
// admitted into it at once (prompt.submit), so it survives a crash and every viewer sees it.
// Its user bubble waits until the authority starts it, so it lands after the reply it waited
// for. Ported from Ink's app/pendingBubbles.ts and hooks/useQueue.ts (server rows).

import type { AdmissionId, InputId } from '../core/ids.js'
import { cancelledAdmission, type PendingRow } from '../wire/schemas.js'

/** What Enter does while a turn runs (`display.busy_input_mode`, read with `config.get {key:'busy'}`). */
export type BusyMode = 'interrupt' | 'queue' | 'steer'

/** A busy mode as the gateway reports it; anything else is the TUI default, `queue`. */
export function busyModeOf(raw: unknown): BusyMode {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''

  return v === 'interrupt' || v === 'steer' ? v : 'queue'
}

/**
 * Where one of this pane's admissions stands. `submitting`: prompt.submit has not answered, and
 * nothing can withdraw it yet; `admitted`: the authority named it `id`; `started`: the FIFO started
 * it (its bubble shows, and it runs as its own turn); `withdrawn`: it left the FIFO without running
 * (this pane withdrew it, or another viewer cancelled it). Only a submitting admission goes back to
 * the composer when prompt.submit fails: a late timeout of a started one must not bring it back.
 */
export type Admission = { kind: 'submitting' } | { kind: 'admitted'; id: AdmissionId } | { kind: 'started' } | { kind: 'withdrawn' }

/** A prompt this pane admitted behind the turn: what its bubble shows, and what Edit restores. */
export interface OwnAdmission<T> {
  /** The submission id it was admitted under. */
  inputId: InputId
  /** Submitting until prompt.submit answers with the authority's id for it; written only by ServerQueue. */
  admission: Admission
  /** The bubble's text (what was typed, before `{!cmd}`s ran). */
  display: string
  item: T
}

/**
 * One queued row the dock shows. `sending`: this pane's admission before prompt.submit answered
 * (nothing can withdraw it yet); `mine`: this pane's admission the authority named (Edit and Steer
 * withdraw it by `id`); `theirs`: another viewer's row of the FIFO, shown and not acted on.
 */
export type ServerQueued<T> =
  | { kind: 'sending'; text: string; own: OwnAdmission<T> }
  | { kind: 'mine'; text: string; own: OwnAdmission<T>; id: AdmissionId }
  | { kind: 'theirs'; text: string; row: PendingRow }

/** A started row's owed bubble: its text, and this pane's admission when it was one (undefined for another viewer's). */
export interface Started<T> {
  text: string
  own: OwnAdmission<T> | undefined
}

/** This pane's admission as a dock row: `mine` once the authority named it. */
function ownRow<T>(own: OwnAdmission<T>): ServerQueued<T> {
  return own.admission.kind === 'admitted'
    ? { id: own.admission.id, kind: 'mine', own, text: own.display }
    : { kind: 'sending', own, text: own.display }
}

/** The FIFO's rows that still wait (Ink's isServerQueued). */
export const isServerQueued = (row: PendingRow) => row.status === 'queued' || row.status === 'unknown'

/** The shared gateway's queue for the shown session, and the bubbles its started rows owe. */
export class ServerQueue<T> {
  rows: PendingRow[] = []
  readonly #own: OwnAdmission<T>[] = []
  /** Input ids whose bubble this pane painted (an idle send, or a started admission). */
  readonly #shown = new Set<InputId>()
  /** Admissions seen queued and never started: a `cancelled` completion of one is not the turn's. */
  readonly #queuedOnly = new Set<AdmissionId>()
  /** Input ids of own admissions the FIFO has listed. */
  readonly #listed = new Set<InputId>()

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

  /** Forgets an own admission (refused, or back in the composer); its state stays where it was. */
  drop(own: OwnAdmission<T>) {
    const at = this.#own.indexOf(own)

    if (at >= 0) {
      this.#own.splice(at, 1)
    }
  }

  /** prompt.submit named a submitting admission `id`: it can be withdrawn now. One that started or left meanwhile stays so. */
  admitted(own: OwnAdmission<T>, id: AdmissionId) {
    if (own.admission.kind === 'submitting') {
      own.admission = { id, kind: 'admitted' }
    }
  }

  /** This pane withdrew `own` (prompt.cancel said terminal): it left the FIFO without running. */
  withdrew(own: OwnAdmission<T>) {
    own.admission = { kind: 'withdrawn' }
    this.drop(own)
  }

  /** A prompt whose bubble this pane painted when it sent it. */
  shown(inputId: InputId) {
    this.#shown.add(inputId)
  }

  /**
   * Takes the FIFO from a session.info (or a reconnect's resume) and returns the bubbles owed,
   * in order: this pane's admissions that started, and another viewer's rows this pane saw move
   * from queued to started (a resume snapshot's started row is already in the replayed history).
   */
  update(rows: PendingRow[] | undefined): Started<T>[] {
    if (!rows) {
      return []
    }

    const was = new Set(this.rows.filter(r => r.status === 'queued').map(r => r.admission_id))
    const owed: Started<T>[] = []

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
          own.admission = { kind: 'started' }
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
        own.admission = { kind: 'withdrawn' }
        this.drop(own)
      }
    }

    return owed
  }

  /** Withdrawn by this pane: its row's `cancelled` completion must not end the running turn. */
  withdrawn(admissionId: AdmissionId) {
    this.#queuedOnly.add(admissionId)
  }

  /** A message.complete that only settles a queued row nobody started (prompt.cancel's), not the running turn. */
  settlesQueuedRow(payload: unknown): boolean {
    const id = cancelledAdmission(payload)

    return id !== undefined && this.#queuedOnly.has(id)
  }

  /** The rows that still wait, oldest first: the FIFO's, then admissions it does not list yet. */
  queued(): ServerQueued<T>[] {
    const rows = this.rows.filter(isServerQueued).map((row): ServerQueued<T> => {
      const own = this.#own.find(o => o.inputId === row.input_id)

      return own ? ownRow(own) : { kind: 'theirs', row, text: row.user }
    })
    const listed = new Set(this.rows.map(r => r.input_id))

    return [...rows, ...this.#own.filter(o => !listed.has(o.inputId)).map(ownRow)]
  }
}
