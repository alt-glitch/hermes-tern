#!/usr/bin/env node
// The size ratchet: lines per src/ file. A file stays at or under 600 lines; a file that was
// over when this started has a ceiling in size-ceilings.json that only goes down, and none may
// pass 1000 unless it was already over then. vendor/ (code kept as its upstream wrote it) and
// view/styles.ts (CSS, whose cascade depends on rule order) are exempt. `--update` lowers the
// ceilings after a file shrinks.
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { ratchet, root } from './ratchet.mjs'

const EXEMPT = ['src/vendor/', 'src/view/styles.ts']

/** Every .ts and .tsx file under `dir`, relative to the frontend. */
function sources(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile() && /\.tsx?$/.test(e.name))
    .map(e => relative(root, resolve(e.parentPath, e.name)))
}

const counts = Object.fromEntries(
  sources(resolve(root, 'src'))
    .filter(path => !EXEMPT.some(e => path === e || path.startsWith(e)))
    .map(path => [path, readFileSync(resolve(root, path), 'utf8').split('\n').length - 1])
)

ratchet({ cap: 1000, counts, file: resolve(root, 'scripts/size-ceilings.json'), limit: 600, name: 'check-size', unit: 'lines' })
