#!/usr/bin/env node
// Every suppression says why. An `eslint-disable` comment (any form) or a `@ts-expect-error`,
// `@ts-ignore` or `@ts-nocheck` directive in src/ must carry a reason after ` -- `, the way eslint
// itself reads one: `// eslint-disable-next-line no-control-regex -- terminal escapes are the input`.
// A boundary cast says `-- boundary: <what crosses>`. See docs/conventions.md#suppressions.
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { root } from './ratchet.mjs'

const DIRECTIVE = /(?:\/\/|\/\*)\s*(eslint-disable(?:-next-line|-line)?|@ts-(?:expect-error|ignore|nocheck))\b(.*)/
const REASON = /\s--\s+\S/

const failures = []

for (const entry of readdirSync(resolve(root, 'src'), { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) {
    continue
  }

  const path = relative(root, resolve(entry.parentPath, entry.name))
  const lines = readFileSync(resolve(root, path), 'utf8').split('\n')

  lines.forEach((line, i) => {
    const match = DIRECTIVE.exec(line)

    if (match && !REASON.test(match[2] ?? '')) {
      failures.push(`${path}:${i + 1} ${match[1]} with no \` -- \` reason`)
    }
  })
}

if (failures.length) {
  console.error(`check-suppressions: ${failures.length} suppression(s) with no reason (docs/conventions.md#suppressions):`)
  console.error(failures.map(f => `  ${f}`).join('\n'))
  process.exit(1)
}

console.log('check-suppressions: ok')
