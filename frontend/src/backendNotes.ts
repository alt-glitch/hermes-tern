// What the backend's own failures put on screen: a slow start's diagnosis, protocol noise, and the
// stray faults the pane survives (Ink's setupGracefulExit).

import { stderrLooksLikeProblem } from '@tui/app/userMessages.js'

import type { NoticeEntry } from './model.js'

interface Note {
  text: string
  tone: NoticeEntry['tone']
}

const STDERR_LINE_CAP = 120
const STDERR_LINES_MAX = 4

/** `gateway.start_timeout`: the client keeps waiting, so a warning, plus the last few failure-looking stderr lines. */
export function slowStartNotes(stderrTail: string | null | undefined): Note[] {
  const problems = (stderrTail ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && stderrLooksLikeProblem(l))
    .slice(-STDERR_LINES_MAX)

  return [
    { text: 'The agent backend is slow to start. Still waiting…', tone: 'warning' },
    ...problems.map(l => ({ text: l.slice(0, STDERR_LINE_CAP), tone: 'error' as const }))
  ]
}

/** `gateway.protocol_error`: stray backend output is noise, said once per run; the preview is capped. */
export function protocolNote(preview: string | null | undefined, warned: boolean): Note | undefined {
  return warned
    ? undefined
    : { text: `The agent backend wrote unexpected output: ${String(preview ?? '').slice(0, STDERR_LINE_CAP)}`, tone: 'info' }
}


/** A write to a closed terminal: nothing can be shown any more, so the pane must exit. */
export function isDeadStream(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code

  return code === 'EIO' || code === 'EPIPE'
}

/** Faults allowed in a window before the pane gives up: a stray one is shown, a loop of them ends the pane. */
export class FaultBudget {
  #at: number[] = []

  constructor(
    readonly max = 10,
    readonly windowMs = 5000
  ) {}

  /** Records a fault at `now`; false once more than `max` landed within the window. */
  take(now = Date.now()): boolean {
    this.#at = [...this.#at.filter(t => now - t < this.windowMs), now]

    return this.#at.length <= this.max
  }
}
