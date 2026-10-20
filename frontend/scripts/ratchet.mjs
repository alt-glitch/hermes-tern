// The ratchet check-size.mjs and check-strict.mjs share: a JSON file of per-file ceilings (lines,
// errors) that can only go down. A file with no entry has the default limit. The check fails when
// a count is over its ceiling, when a ceiling is higher than the committed one (HEAD), and when a
// ceiling has slack (the count went down): `--update` then lowers the ceilings to the counts and
// drops the entries a file no longer needs. It never raises one. A pooled ratchet (strict errors)
// lets a ceiling rise while the total does not, so a move can carry its debt to a new file.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The frontend directory: the root every ceiling key is relative to. */
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The ceilings `file` holds at HEAD; null before it is first committed. */
function committed(file) {
  try {
    const text = execFileSync('git', ['-C', root, 'show', `HEAD:./${relative(root, file)}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })

    return JSON.parse(text)
  } catch {
    return null
  }
}

const sorted = entries => Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

/**
 * Checks `counts` (file → count) against the ceilings in `file`, or with `--update` lowers them.
 * `limit` is the ceiling of a file with no entry. `cap`, when given, is a hard cap only a file
 * whose committed ceiling is already over it may pass. `pooled` checks raises against the total.
 * Exits non-zero on a failure.
 */
export function ratchet({ name, file, counts, limit, cap, unit, pooled = false }) {
  const ceilings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const base = committed(file)
  const at = relative(root, file)

  if (process.argv.includes('--update')) {
    const next = sorted(
      Object.entries(counts)
        .filter(([, count]) => count > limit)
        .map(([path, count]) => [path, Math.min(count, ceilings[path] ?? count)])
    )

    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
    console.log(`${name}: wrote ${Object.keys(next).length} ceilings to ${at}`)
  }

  const now = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const failures = []

  for (const [path, count] of Object.entries(counts)) {
    const ceiling = now[path] ?? limit

    if (count > ceiling) {
      failures.push(`${path}: ${count} ${unit}, over its ceiling of ${ceiling}`)
    }

    if (cap !== undefined && count > cap && !(base === null || (base[path] ?? 0) > cap)) {
      failures.push(`${path}: ${count} ${unit}, over the hard cap of ${cap}`)
    }
  }

  const total = entries => Object.values(entries).reduce((sum, n) => sum + n, 0)

  if (pooled && base !== null && total(now) > total(base)) {
    failures.push(`ceilings total ${total(now)} ${unit}, raised from ${total(base)}; the total only goes down`)
  }

  for (const [path, ceiling] of Object.entries(now)) {
    const was = base === null || pooled ? undefined : (base[path] ?? limit)

    if (was !== undefined && ceiling > was) {
      failures.push(`${path}: ceiling raised from ${was} to ${ceiling}; ceilings only go down`)
    } else if ((counts[path] ?? 0) < ceiling) {
      failures.push(`${path}: ${counts[path] ?? 0} ${unit} under its ceiling of ${ceiling}; run with --update to lower it`)
    }
  }

  if (failures.length) {
    console.error(`${name}: ${failures.length} failure(s) against ${at}:`)

    for (const failure of failures) {
      console.error(`  ${failure}`)
    }

    process.exit(1)
  }

  console.log(`${name}: ok (${Object.keys(counts).length} files, ${Object.keys(now).length} with ceilings)`)
}
