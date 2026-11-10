#!/usr/bin/env node
// Type-checks the frontend. `@hermes/shared` is Hermes' own source, compiled into this program
// from the pinned checkout, so tsc checks it under this project's stricter flags
// (noUncheckedIndexedAccess and the rest). Hermes checks that source under its own flags in its own
// CI; a diagnostic inside it is not this project's to fix, and would block every Hermes bump. So
// diagnostics located in `@hermes/shared` are counted and left out; every other one fails the check.
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = resolve(root, 'node_modules/typescript/bin/tsc')
const ran = spawnSync(process.execPath, [tsc, '--noEmit', '--pretty', 'false', '-p', resolve(root, 'tsconfig.json')], { cwd: root, encoding: 'utf8' })

if (ran.error) {
  console.error(`typecheck: could not run tsc: ${ran.error.message}`)
  process.exit(1)
}

/** A diagnostic's first line: `path(line,col): error TSnnnn: message`. Continuation lines are indented. */
const HEAD = /^(.+?)\(\d+,\d+\): error TS\d+: /
const SHARED = /(^|\/)(node_modules\/@hermes\/shared|\.hermes-src\/apps\/shared)\//

const ours = []
let shared = 0
let keep = false

for (const line of `${ran.stdout}${ran.stderr}`.split('\n')) {
  const head = HEAD.exec(line)

  if (head) {
    keep = !SHARED.test(head[1])
    shared += keep ? 0 : 1
  }

  if (line.trim() && (head ? keep : keep || !/^\s/.test(line))) {
    ours.push(line)
  }
}

if (ours.length > 0) {
  console.error(ours.join('\n'))
  process.exit(1)
}

if (ran.status !== 0 && shared === 0) {
  console.error(`typecheck: tsc exited ${ran.status} with no diagnostic`)
  process.exit(1)
}

console.log(shared > 0 ? `typecheck: ok (${shared} diagnostic${shared === 1 ? '' : 's'} inside @hermes/shared left to Hermes)` : 'typecheck: ok')
