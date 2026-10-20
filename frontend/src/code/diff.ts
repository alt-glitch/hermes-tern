// Unified diffs as the tools return them: the hunks without the file headers, and their counts.

/** The unified diff in hermes's colored `inline_diff`, without ANSI and the review header. */
export function plainDiff(raw: string): string | undefined {
  // eslint-disable-next-line no-control-regex -- ANSI color escapes are what this strips
  return hunks(raw.replace(/\x1b\[[0-9;]*m/g, ''))
}

/** A unified diff from its first hunk on (file headers dropped). */
export function hunks(diff: string | undefined): string | undefined {
  const lines = diff?.split('\n') ?? []
  const start = lines.findIndex(l => l.startsWith('@@'))

  return start < 0 ? undefined : lines.slice(start).join('\n').trimEnd()
}

/** The lines a diff adds and removes (file headers not counted). */
export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0

  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added++
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed++
    }
  }

  return { added, removed }
}
