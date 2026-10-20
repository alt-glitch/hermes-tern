// Small parts the sheets share.

import type { ChatPorts } from '../app/ports.js'
import { errorText } from '../core/errors.js'
import type { OverlayHost } from '../overlay.js'

/**
 * Re-renders every `ms` while a sheet is open, so its clocks and live rows move. The returned
 * function stops it: call it from the sheet's onClose.
 */
export function tickWhileOpen(host: Pick<OverlayHost, 'changed'>, ms: number): () => void {
  const timer = setInterval(() => host.changed(), ms)

  return () => clearInterval(timer)
}

/** Runs `work`; what it throws becomes an error notice in the transcript, so a sheet's action never rejects. */
export async function reportError(transcript: Pick<ChatPorts['transcript'], 'notice'>, work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (error) {
    transcript.notice(errorText(error), 'error')
  }
}

/** One count of a summary: the items it counts, and its label (`[one, many]` when the label follows the count). */
export type Tally<T> = readonly [counts: (item: T) => boolean, label: string | readonly [one: string, many: string]]

/** `2 running · 1 done`: each tally's count and label, the zero ones left out; `none yet` when all are. */
export function countSummary<T>(items: readonly T[], tallies: readonly Tally<T>[]): string {
  return (
    tallies
      .map(([counts, label]) => {
        const n = items.filter(counts).length

        return n ? `${n} ${typeof label === 'string' ? label : label[n === 1 ? 0 : 1]}` : ''
      })
      .filter(Boolean)
      .join(' · ') || 'none yet'
  )
}
