// Text helpers every layer shares: a count with its noun, a cut text, and terminal output without
// its escapes. The views' own formats (durations, times, paths) are view/format.ts's.

/** `1 file`, `3 files`: a count and its noun; `many` defaults to `one` with an `s`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * `text` cut to `max` characters. `mark: 'end'` (the default) ends a cut text with `…` inside
 * `max`, for a title or a label; `mark: 'line'` keeps `max` characters and puts `…` on a line of
 * its own, for a body whose end is dropped.
 */
export function clip(text: string, o: { max: number; mark?: 'end' | 'line' }): string {
  if (text.length <= o.max) {
    return text
  }

  return o.mark === 'line' ? `${text.slice(0, o.max)}\n…` : `${text.slice(0, o.max - 1)}…`
}

// eslint-disable-next-line no-control-regex -- terminal escapes are what this strips
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g

/** Terminal output without its escape sequences (CSI, OSC, and the two-byte ones); `\r` and the other control characters stay. */
export function withoutEscapes(text: string): string {
  return text.replace(ESCAPES, '')
}
