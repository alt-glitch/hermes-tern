// A masked field shows one bullet per grapheme of the secret, so Tern's caret
// and native edits count bullets while the secret counts UTF-16 units. These
// map between the two, so an edit never splits a surrogate pair of the secret.

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const BULLET = '•'

/** A native `edit` event's range, text and caret. */
export interface FieldEdit {
  from: number
  to: number
  text: string
  cursor: number
  len: number
}

/** The UTF-16 offset each grapheme of `secret` starts at, then `secret.length`. */
function boundaries(secret: string): number[] {
  const at: number[] = []

  for (const { index } of graphemes.segment(secret)) {
    at.push(index)
  }

  at.push(secret.length)

  return at
}

/** What a masked field shows for `secret`: one bullet per grapheme. */
export function maskOf(secret: string): string {
  return BULLET.repeat(boundaries(secret).length - 1)
}

/** The masked caret for UTF-16 offset `at` of `secret`: the graphemes wholly before it. */
export function maskedOffset(secret: string, at: number): number {
  const bounds = boundaries(secret)
  let n = 0

  while (n + 1 < bounds.length && (bounds[n + 1] ?? 0) <= at) {
    n++
  }

  return n
}

/**
 * A native edit of the masked text as an edit of `secret`; null when Tern saw
 * a different mask than the one `secret` draws (keys in flight).
 */
export function unmaskEdit(secret: string, ev: FieldEdit): FieldEdit | null {
  const bounds = boundaries(secret)
  const count = bounds.length - 1

  if (ev.len !== count) {
    return null
  }

  const real = (masked: number) => bounds[Math.max(0, Math.min(count, masked))] ?? secret.length
  const from = real(ev.from)
  const to = real(ev.to)
  // The caret is in Tern's text after the edit: mask before `from`, the inserted text, mask after `to`.
  const after = ev.cursor - ev.from - ev.text.length

  const cursor =
    ev.cursor <= ev.from
      ? real(ev.cursor)
      : after <= 0
        ? from + (ev.cursor - ev.from)
        : real(ev.to + after) - to + from + ev.text.length

  return { cursor, from, len: secret.length, text: ev.text, to }
}
