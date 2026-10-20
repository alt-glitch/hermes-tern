// A tool card that throws while it draws costs that card, not the frame: the shell draws the
// generic card in its place and tells the pane here, once per tool name (a broken card would
// otherwise throw again on every frame).

import { errorText } from '../../core/errors.js'

/** Where a card that failed is told: the tool's name and what it threw. */
export type CardFaultSink = (name: string, error: unknown) => void

let sink: CardFaultSink = () => undefined
let told = new Set<string>()

/** Tells `next` of each tool whose card throws from now on, once per tool name. */
export function onCardFault(next: CardFaultSink) {
  sink = next
  told = new Set()
}

/** Tool `name`'s card threw `error`: told the first time for that name. */
export function cardFault(name: string, error: unknown) {
  if (told.has(name)) {
    return
  }

  told.add(name)
  sink(name, error)
}

/**
 * A sink that writes `notice` once the frame being drawn is done (a card throws mid-frame, and the
 * notice changes the transcript that frame draws).
 */
export function noticeSink(notice: (text: string) => void): CardFaultSink {
  return (name, error) => queueMicrotask(() => notice(`The ${name} card failed to draw (${errorText(error)}); it shows as a plain card.`))
}
