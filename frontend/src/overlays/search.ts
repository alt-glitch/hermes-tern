// Shared key handling of the `picker` sheets (models, sessions): Tern draws
// the search line from `query` but never edits it, so typing, ↑/↓, the
// filtering and the match marks are computed here.

import type { Key } from '@stencil-hq/tern'

const PAGE = 10

/** The search `query` after a typing key, or undefined when `key` doesn't edit it. */
export function editQuery(key: Key, query: string): string | undefined {
  if (key.name === 'backspace') {
    return key.alt || key.ctrl ? query.replace(/\S*\s*$/, '') : query.slice(0, -1)
  }

  if (key.ctrl && key.name === 'u') {
    return ''
  }

  if (key.name === 'paste' || (key.text && !key.ctrl && !key.meta)) {
    return query + (key.text ?? '').replace(/\s+/g, ' ')
  }

  return undefined
}

/** The selection after ↑/↓ (⌃P/⌃N), PgUp/PgDn or Home/End among `ids`, or undefined when `key` doesn't move it. */
export function moveSelection(key: Key, ids: readonly string[], selected: string | undefined): string | undefined {
  if (!ids.length) {
    return undefined
  }

  const at = selected === undefined ? -1 : ids.indexOf(selected)

  const step =
    key.name === 'up' || (key.ctrl && key.name === 'p')
      ? -1
      : key.name === 'down' || (key.ctrl && key.name === 'n')
        ? 1
        : key.name === 'page_up'
          ? -PAGE
          : key.name === 'page_down'
            ? PAGE
            : 0

  if (step) {
    return ids[Math.max(0, Math.min(ids.length - 1, at + step))]
  }

  if (key.name === 'home') {
    return ids[0]
  }

  if (key.name === 'end') {
    return ids.at(-1)
  }

  return undefined
}

/** One ranked match: the item and the matched character positions in its text. */
export interface Ranked<T> {
  item: T
  positions: number[]
}

/**
 * The items whose text contains every whitespace-separated word of `query`
 * (case-insensitive), best first: a word found whole beats one found as a
 * scattered subsequence, and earlier and word-start hits rank higher. An
 * empty query keeps every item in order.
 */
export function rank<T>(items: readonly T[], query: string, textOf: (item: T) => string): Ranked<T>[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)

  if (!words.length) {
    return items.map(item => ({ item, positions: [] }))
  }

  const scored: (Ranked<T> & { score: number; index: number })[] = []

  items.forEach((item, index) => {
    const text = textOf(item).toLowerCase()
    const positions = new Set<number>()
    let score = 0

    for (const word of words) {
      const at = text.indexOf(word)

      if (at >= 0) {
        const boundary = at === 0 || /[\s/_.:-]/.test(text[at - 1] ?? '')
        score += 100 - Math.min(at, 50) + (boundary ? 25 : 0)

        for (let i = at; i < at + word.length; i++) {
          positions.add(i)
        }

        continue
      }

      // A scattered subsequence: each letter after the previous one.
      let from = 0

      for (const ch of word) {
        const i = text.indexOf(ch, from)

        if (i < 0) {
          return
        }

        positions.add(i)
        from = i + 1
      }

      score += 10
    }

    scored.push({ index, item, positions: [...positions].sort((a, b) => a - b), score })
  })

  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item, positions }) => ({ item, positions }))
}

/** Contiguous `[from, to)` runs of matched character positions below `limit`: a picker item's `hits`. */
export function hitRuns(positions: readonly number[], limit: number): [number, number][] {
  const runs: [number, number][] = []

  for (const p of positions) {
    if (p >= limit) {
      break
    }

    const last = runs.at(-1)

    if (last && last[1] === p) {
      last[1] = p + 1
    } else {
      runs.push([p, p + 1])
    }
  }

  return runs
}
