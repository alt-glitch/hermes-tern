// The composer's Markdown: live styling of the draft as `decor` ranges on Tern's
// `editor` node, list continuation on a new line, and the bold / italic toggles.
// The text itself stays plain Markdown; only its look changes. Offsets are UTF-16.

import type { Decor } from '@stencil-hq/tern'

/** A replacement of `[from, to)` by `text`, with the caret (and selection anchor) after it. */
export interface Splice {
  from: number
  to: number
  text: string
  cursor: number
  anchor?: number
}

const FENCE = /^\s*(```|~~~)/
const HEADING = /^(?<marker>#{1,6})(\s+)/
const QUOTE = /^(?<marker>\s*>+\s?)/
const LIST = /^(?<indent>\s*)(?<bullet>[-*+]|\d{1,9}[.)])(\s+)(?<box>\[[ xX]\](?:\s+|$))?/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
// Inline marks. Each runs on a copy where earlier marks are blanked out (same length), so a
// bold's `**` is never read as two italic `*`s and nothing inside a code span is styled.
const CODE_SPAN = /(?<ticks>`+)(?!`)([^\n]*?[^`\n])\k<ticks>(?!`)/g
const BOLD = /(\*\*|__)(?=\S)([^\n]*?\S)\1/g
const ITALIC_STAR = /(?<![*\\])\*(?=[^\s*])([^\n*]*?[^\s*\\])\*(?!\*)/g
const ITALIC_UNDERSCORE = /(?<![\w\\])_(?=[^\s_])([^\n_]*?[^\s_\\])_(?![\w])/g
const STRIKE = /~~(?=\S)([^\n]*?\S)~~/g
const LINK = /\[(?<label>[^\]\n]+)\]\(([^)\s]+)\)/g

/**
 * The draft's Markdown as non-overlapping `decor` runs: markers dim, bold `strong`, italic
 * `em`, code `code`, headings `strong`, list markers `accent`. Nested marks combine their
 * tokens (`strong em`), so Tern never has to merge overlapping ranges.
 */
export function markdownDecor(text: string): Decor[] {
  if (!text) {
    return []
  }

  const marks: string[][] = Array.from({ length: text.length }, () => [])
  const mark = (from: number, to: number, s: string) => {
    for (const tokens of marks.slice(from, to)) {
      if (!tokens.includes(s)) {
        tokens.push(s)
      }
    }
  }

  let at = 0
  let fenced = false

  for (const line of text.split('\n')) {
    const end = at + line.length

    if (FENCE.test(line)) {
      mark(at, end, 'dim')
      fenced = !fenced
    } else if (fenced) {
      mark(at, end, 'code')
    } else {
      blockMarks(line, at, mark)
    }

    at = end + 1
  }

  return runs(marks)
}

/** One line outside a fence: its block marker, then its inline marks. */
function blockMarks(line: string, at: number, mark: (from: number, to: number, s: string) => void) {
  if (RULE.test(line)) {
    return mark(at, at + line.length, 'dim')
  }

  let body = 0
  const heading = HEADING.exec(line)
  const quote = heading ? null : QUOTE.exec(line)

  // A match fills every group the defaults below stand in for; they only satisfy the index signature.
  if (heading) {
    const { marker = '' } = heading.groups ?? {}
    mark(at, at + marker.length, 'dim')
    body = heading[0].length
    mark(at + body, at + line.length, 'strong')
  } else if (quote) {
    const { marker = '' } = quote.groups ?? {}
    mark(at, at + marker.length, 'dim')
    body = marker.length
    mark(at + body, at + line.length, 'muted')
  }

  const list = LIST.exec(line.slice(body))

  if (list) {
    const { box, bullet = '', indent = '' } = list.groups ?? {}
    const start = body + indent.length
    mark(at + start, at + start + bullet.length, 'accent')

    if (box) {
      const boxAt = body + list[0].length - box.length
      mark(at + boxAt, at + boxAt + 3, 'accent')
    }

    body += list[0].length
  }

  inlineMarks(line, body, at, mark)
}

function inlineMarks(line: string, from: number, at: number, mark: (from: number, to: number, s: string) => void) {
  let rest = ' '.repeat(from) + line.slice(from)
  // Blanks a styled run out of `rest`, so later marks don't read inside it.
  const take = (start: number, len: number) => {
    rest = rest.slice(0, start) + '\u0000'.repeat(len) + rest.slice(start + len)
  }

  for (const m of [...rest.matchAll(CODE_SPAN)]) {
    const tick = m.groups?.['ticks']?.length ?? 0
    mark(at + m.index, at + m.index + tick, 'dim')
    mark(at + m.index + tick, at + m.index + m[0].length - tick, 'code')
    mark(at + m.index + m[0].length - tick, at + m.index + m[0].length, 'dim')
    take(m.index, m[0].length)
  }

  for (const m of [...rest.matchAll(LINK)]) {
    const label = m.groups?.['label']?.length ?? 0
    mark(at + m.index, at + m.index + 1, 'dim')
    mark(at + m.index + 1, at + m.index + 1 + label, 'link')
    mark(at + m.index + 1 + label, at + m.index + m[0].length, 'dim')
    // The label keeps its own marks (a bold link); the URL takes none.
    take(m.index + 2 + label, m[0].length - 2 - label)
  }

  const pair = (re: RegExp, marker: number, s: string) => {
    for (const m of [...rest.matchAll(re)]) {
      const len = m[0].length
      mark(at + m.index, at + m.index + marker, 'dim')
      mark(at + m.index + marker, at + m.index + len - marker, s)
      mark(at + m.index + len - marker, at + m.index + len, 'dim')
      // Only the markers go: the text between them may carry the next mark (bold italic).
      take(m.index, marker)
      take(m.index + len - marker, marker)
    }
  }

  pair(BOLD, 2, 'strong')
  pair(STRIKE, 2, 'del')
  pair(ITALIC_STAR, 1, 'em')
  pair(ITALIC_UNDERSCORE, 1, 'em')
}

/** Per-character token lists as maximal runs. */
function runs(marks: string[][]): Decor[] {
  const out: Decor[] = []
  let from = 0

  for (let i = 1; i <= marks.length; i++) {
    const s = marks[from]?.join(' ') ?? ''

    if (i < marks.length && marks[i]?.join(' ') === s) {
      continue
    }

    if (s) {
      out.push({ from, s, to: i })
    }

    from = i
  }

  return out
}

/**
 * A new line at `cursor` inside a list item: the next item's marker (`- `, `2. `, `- [ ] `), or,
 * on an item with nothing after its marker, the marker removed (an empty item ends the list).
 * Undefined outside a list, or with the caret still inside the marker.
 */
export function listNewline(text: string, cursor: number): Splice | undefined {
  const start = text.lastIndexOf('\n', cursor - 1) + 1
  const nl = text.indexOf('\n', cursor)
  const end = nl < 0 ? text.length : nl
  const line = text.slice(start, end)
  const m = LIST.exec(line)

  if (!m || cursor - start < m[0].length) {
    return undefined
  }

  if (!line.slice(m[0].length).trim()) {
    return { cursor: start, from: start, text: '', to: end }
  }

  const [, indent = '', bullet = '', gap = ' ', box] = m
  const n = /^\d+/.exec(bullet)?.[0]
  const next = n ? `${Number(n) + 1}${bullet.slice(n.length)}` : bullet
  const insert = `\n${indent}${next}${gap}${box ? '[ ] ' : ''}`

  return { cursor: cursor + insert.length, from: cursor, text: insert, to: cursor }
}

/**
 * Toggles an inline mark (`**` bold, `_` italic) on `[from, to)`. A selection is wrapped, or
 * unwrapped when the mark already surrounds it. At a caret: inside an empty pair the pair goes;
 * at the end of a marked run the caret steps out of it; inside a run the run is unwrapped;
 * anywhere else an empty pair opens with the caret inside it, so typing goes in marked.
 */
export function toggleMark(text: string, from: number, to: number, marker: string): Splice {
  const n = marker.length

  if (from !== to) {
    if (text.slice(from - n, from) === marker && text.slice(to, to + n) === marker && !doubled(text, from - n, to + n, marker)) {
      return { anchor: from - n, cursor: to - n, from: from - n, text: text.slice(from, to), to: to + n }
    }

    const inner = text.slice(from, to)

    if (inner.length > 2 * n && inner.startsWith(marker) && inner.endsWith(marker)) {
      return { anchor: from, cursor: to - 2 * n, from, text: inner.slice(n, -n), to }
    }

    return { anchor: from + n, cursor: to + n, from, text: `${marker}${inner}${marker}`, to }
  }

  const at = from

  if (text.slice(at - n, at) === marker && text.slice(at, at + n) === marker) {
    return { cursor: at - n, from: at - n, text: '', to: at + n }
  }

  const run = markedRun(text, at, marker)

  if (run && at === run.close) {
    return { cursor: at + n, from: at, text: '', to: at }
  }

  if (run) {
    const inner = text.slice(run.open + n, run.close)

    return { cursor: at - n, from: run.open, text: inner, to: run.close + n }
  }

  // Tern keeps a Shift or mouse selection to itself, so the caret stands in for it: the word it
  // touches is marked, as Google Docs does.
  const word = wordAt(text, at)

  if (word) {
    return { cursor: at + n, from: word.from, text: `${marker}${text.slice(word.from, word.to)}${marker}`, to: word.to }
  }

  return { cursor: at + n, from: at, text: `${marker}${marker}`, to: at }
}

const WORD = /[\p{L}\p{N}'’-]/u

/** The word the caret is in or touches (the one before it first); undefined between spaces. */
function wordAt(text: string, at: number): { from: number; to: number } | undefined {
  let from = at
  let to = at

  while (from > 0 && WORD.test(text[from - 1] ?? '')) {
    from--
  }

  while (to < text.length && WORD.test(text[to] ?? '')) {
    to++
  }

  return from < to ? { from, to } : undefined
}

/** `_` next to another `_` (or `*` to `*`) is a different mark: `__bold__` is not italic. */
function doubled(text: string, open: number, close: number, marker: string): boolean {
  return marker.length === 1 && (text[open - 1] === marker || text[close] === marker)
}

/** The marked run on `at`'s line that holds the caret: where its opening and closing markers start. */
function markedRun(text: string, at: number, marker: string): { open: number; close: number } | undefined {
  const start = text.lastIndexOf('\n', at - 1) + 1
  const nl = text.indexOf('\n', at)
  const line = text.slice(start, nl < 0 ? text.length : nl)
  const re = marker === '**' ? /\*\*(?=\S)([^\n]*?\S)\*\*/g : /(?<![\w_])_(?=[^\s_])([^\n_]*?[^\s_])_(?![\w_])/g

  for (const m of line.matchAll(re)) {
    const open = start + m.index
    const close = open + m[0].length - marker.length

    if (at > open + marker.length - 1 && at <= close) {
      return { close, open }
    }
  }

  return undefined
}
