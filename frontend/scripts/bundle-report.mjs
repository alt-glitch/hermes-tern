#!/usr/bin/env node
// What each module adds to the bundle, and how that changed. Builds with esbuild's metafile into
// `.dist-report/` (gitignored, never the committed dist/entry.js), prints the bytes each src/
// module puts in the output and the totals of its dependencies, each with its change against the
// saved baseline. `--save` makes this build the baseline: save on main, then report on a branch.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bundle } from './build.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = resolve(root, '.dist-report')
const baselineFile = resolve(dir, 'baseline.json')
const save = process.argv.includes('--save')

mkdirSync(dir, { recursive: true })

const { metafile } = await bundle({ metafile: true, outfile: resolve(dir, 'entry.js') })
const [output] = Object.values(metafile.outputs)

/** Where an input's bytes are counted: a src/ file by itself, anything else by its package. */
function bucket(path) {
  if (path.startsWith('src/')) {
    return path
  }

  const pkg = /^node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path)

  if (pkg) {
    return `npm:${pkg[1]}`
  }

  const hermes = /^\.hermes-src\/(ui-tui|apps\/[^/]+)/.exec(path)

  return hermes ? `hermes:${hermes[1]}` : `other:${path}`
}

/** @type {Record<string, number>} */
const sizes = {}

for (const [path, { bytesInOutput }] of Object.entries(output.inputs)) {
  const name = bucket(path)
  sizes[name] = (sizes[name] ?? 0) + bytesInOutput
}

sizes['(total)'] = output.bytes

if (save) {
  writeFileSync(baselineFile, `${JSON.stringify(sizes, null, 2)}\n`)
  console.log(`bundle-report: saved the baseline (${output.bytes.toLocaleString('en-US')} bytes)`)
  process.exit(0)
}

/** @type {Record<string, number> | null} */
const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : null
const names = [...new Set([...Object.keys(sizes), ...Object.keys(baseline ?? {})])]
const fmt = n => n.toLocaleString('en-US')
const delta = n => (n === 0 ? '' : `${n > 0 ? '+' : ''}${fmt(n)}`)

/** One table: `names` by size, largest first, with each change against the baseline. */
function table(title, rows) {
  const sorted = rows.sort((a, b) => (sizes[b] ?? 0) - (sizes[a] ?? 0) || a.localeCompare(b))
  const width = Math.max(...sorted.map(n => n.length), title.length)

  console.log(`\n${title.padEnd(width)}  ${'bytes'.padStart(9)}  ${baseline ? 'change'.padStart(8) : ''}`)

  for (const name of sorted) {
    const now = sizes[name] ?? 0
    const change = baseline ? delta(now - (baseline[name] ?? 0)) : ''
    const note = !(name in sizes) ? '  (gone)' : baseline && !(name in baseline) ? '  (new)' : ''

    console.log(`${name.padEnd(width)}  ${fmt(now).padStart(9)}  ${change.padStart(8)}${note}`)
  }
}

table('src/ module', names.filter(n => n.startsWith('src/')))
table('dependency', names.filter(n => !n.startsWith('src/') && n !== '(total)'))
table('', ['(total)'])

if (!baseline) {
  console.log('\nbundle-report: no baseline; `node scripts/bundle-report.mjs --save` on main records one')
}
