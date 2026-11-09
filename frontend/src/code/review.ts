// Turn git's unified hunks into aligned, numbered old/new source lines.
import { hunks } from './diff.js'

export interface ReviewLine {
  line: number
  text: string
  change: 'context' | 'added' | 'removed'
}

export interface ReviewPair {
  old?: ReviewLine
  next?: ReviewLine
}

export interface ReviewHunk {
  header: string
  pairs: ReviewPair[]
}

export interface ReviewTarget {
  line: number
  side: 'old' | 'new'
}

/** Pair adjacent removals and additions; retain empty halves to align code columns. */
export function reviewHunks(raw: string): ReviewHunk[] {
  const body = hunks(raw)
  if (!body) return []

  const result: ReviewHunk[] = []
  let current: ReviewHunk | undefined
  let oldLine = 0
  let newLine = 0
  let removed: ReviewLine[] = []
  let added: ReviewLine[] = []

  const flush = () => {
    if (current) {
      for (let i = 0; i < Math.max(removed.length, added.length); i++) {
        const old = removed[i]
        const next = added[i]
        current.pairs.push({ ...(old ? { old } : {}), ...(next ? { next } : {}) })
      }
    }
    removed = []
    added = []
  }

  for (const line of body.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header) {
      flush()
      oldLine = Number(header[1])
      newLine = Number(header[2])
      current = { header: line, pairs: [] }
      result.push(current)
    } else if (current && line.startsWith(' ')) {
      flush()
      const text = line.slice(1)
      current.pairs.push({
        old: { change: 'context', line: oldLine++, text },
        next: { change: 'context', line: newLine++, text }
      })
    } else if (current && line.startsWith('-')) {
      removed.push({ change: 'removed', line: oldLine++, text: line.slice(1) })
    } else if (current && line.startsWith('+')) {
      added.push({ change: 'added', line: newLine++, text: line.slice(1) })
    }
    // A backslash "no newline" marker or file metadata is not a source line.
  }

  flush()
  return result
}

/** Changed lines suitable for notes; the new half of a replacement comes first. */
export function reviewTargets(hunks: readonly ReviewHunk[]): ReviewTarget[] {
  return hunks.flatMap(hunk => hunk.pairs.flatMap(pair => [
    ...(pair.next?.change === 'added' ? [{ line: pair.next.line, side: 'new' as const }] : []),
    ...(pair.old?.change === 'removed' ? [{ line: pair.old.line, side: 'old' as const }] : [])
  ]))
}

/** Original line numbers, with blank rows for a missing side of the change. */
export function reviewSide(hunk: ReviewHunk, side: 'old' | 'new'): string {
  return hunk.pairs.map(pair => {
    const line = side === 'old' ? pair.old : pair.next
    if (!line) return '       '

    const sign = line.change === 'added' ? '+' : line.change === 'removed' ? '-' : ' '
    return String(line.line).padStart(4, ' ') + ' ' + sign + ' ' + line.text
  }).join('\n')
}
