// The session's run status for Tern, over the OSC 7501 Program Status Protocol
// (https://mitchellh.com/writing/program-status-osc7501): working, waiting on the user, done or
// failed. Tern shows it on the pane's icon, files it in its inbox and banners, and posts a system
// notification while Tern is in the background (when the pane needs the user, and, with the
// setting on, when a turn ends). The status is read from the pane's own state after every frame,
// so no event has to remember to report it, and a report goes out only when it changed.

import { reportProgramStatus } from '../surface/osc.js'

/** What a waiting question asks for, in OSC 7501's `kind` words. */
export type BlockedKind = 'auth' | 'permission' | 'question'

/** A question sheet open in the pane: what it asks for, and its one-line summary. */
export interface Waiting {
  readonly kind: BlockedKind
  readonly msg: string
}

/** The run status, in OSC 7501 terms. */
export type RunStatus =
  | { readonly state: 'idle' | 'working' | 'done' }
  | ({ readonly state: 'blocked' } & Waiting)
  | { readonly state: 'error'; readonly msg: string }

/** How the newest turn stands, as the transcript keeps it. */
export type LastTurn = { readonly status: 'live' | 'done' | 'interrupted' } | { readonly status: 'error'; readonly error?: string | undefined }

/** What the status is read from, after each frame. */
export interface StatusSources {
  /** The shown session's live id; null while none is shown. */
  readonly sid: string | null
  /** A turn (or a send's `{!cmd}`s, or a compaction) runs. */
  readonly working: boolean
  /** The newest open question sheet, if any. */
  readonly waiting: Waiting | undefined
  /** The newest turn in the transcript, if any. */
  readonly lastTurn: LastTurn | undefined
}

/** The protocol's limit on the decoded `msg`. */
const MSG_MAX_BYTES = 2048

/** The app id Tern files the record under. */
const APP = 'hermes'

/**
 * The status the sources show. A waiting question wins over a running turn, since the turn
 * cannot go on without the answer. A turn that ended counts as done or failed only when this pane
 * saw it run (`ranHere`): a resumed session's stored last turn is old news, and an interrupted one
 * goes back to idle, as the user stopped it.
 */
export function runStatus(s: StatusSources, ranHere: boolean): RunStatus {
  if (s.waiting) {
    return { state: 'blocked', ...s.waiting }
  }

  if (s.working) {
    return { state: 'working' }
  }

  if (!ranHere || !s.lastTurn) {
    return { state: 'idle' }
  }

  if (s.lastTurn.status === 'error') {
    return { msg: s.lastTurn.error || 'The turn failed', state: 'error' }
  }

  return { state: s.lastTurn.status === 'done' ? 'done' : 'idle' }
}

/** `text` as one line of printable UTF-8 within the protocol's limit, base64; '' when nothing is left. */
function encodeMsg(text: string): string {
  // eslint-disable-next-line no-control-regex -- Tern drops a whole report whose text holds a control character
  let line = text.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim()

  while (Buffer.byteLength(line) > MSG_MAX_BYTES) {
    line = line.slice(0, Math.floor(line.length * 0.9))
  }

  return line ? Buffer.from(line).toString('base64') : ''
}

/** The report body for `status`: `state=…[:kind=…]:app=hermes[:msg=…]`. */
export function reportBody(status: RunStatus): string {
  const kind = status.state === 'blocked' ? `:kind=${status.kind}` : ''
  const msg = status.state === 'blocked' || status.state === 'error' ? encodeMsg(status.msg) : ''

  return `state=${status.state}${kind}:app=${APP}${msg ? `:msg=${msg}` : ''}`
}

/** Reports the run status to Tern when it changes, and takes the record away when the pane ends. */
export class ProgramStatus {
  readonly #write: (body: string) => void
  /** The body Tern holds now; undefined before the first report and after clear(). */
  #reported: string | undefined
  /** The session this pane last saw working: only its turns' ends count as done or failed. */
  #ranIn: string | null = null
  #closed = false

  constructor(write: (body: string) => void = reportProgramStatus) {
    this.#write = write
  }

  /** Reads the status from `s` and reports it if it changed. */
  sync(s: StatusSources) {
    if (this.#closed) {
      return
    }

    if (s.working && s.sid) {
      this.#ranIn = s.sid
    }

    const body = reportBody(runStatus(s, s.sid !== null && s.sid === this.#ranIn))

    if (body !== this.#reported) {
      this.#reported = body
      this.#write(body)
    }
  }

  /** The pane ends: the record goes, so no `done` outlives the session that set it. */
  clear() {
    this.#closed = true

    if (this.#reported !== undefined) {
      this.#reported = undefined
      this.#write('state=clear')
    }
  }
}
