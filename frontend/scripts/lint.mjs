#!/usr/bin/env node
// The lint ratchet: eslint.config.js's rules on every src/ file, without the legacy overrides, and
// the errors counted per file and rule. scripts/lint-legacy.json holds the counts the code had when
// the rules came in; a count only goes down, a file and rule with no entry may have none, and the
// list may not gain an entry against HEAD. An error over its count prints with the section of
// docs/conventions.md that explains it. `--update` lowers the counts after a fix and drops the
// entries a cleaned file no longer needs.
import { relative, resolve } from 'node:path'

import { ESLint } from 'eslint'

import { LEGACY, rules, SECTIONS, see } from '../eslint.config.js'
import { ratchet, root } from './ratchet.mjs'

const FILE = resolve(root, 'scripts/lint-legacy.json')

const eslint = new ESLint({ cwd: root, overrideConfig: rules, overrideConfigFile: true })
const results = await eslint.lintFiles(['src'])

const counts = {}
const messages = new Map()
const broken = []

for (const result of results) {
  const path = relative(root, result.filePath)

  for (const m of result.messages) {
    const where = `${path}:${m.line}:${m.column}`

    // A parse error, or an eslint-disable comment that disables nothing: neither has a rule to count.
    if (!m.ruleId) {
      broken.push(`${where} ${m.message}`)
      continue
    }

    const key = `${path} ${m.ruleId}`
    const section = SECTIONS[m.ruleId]
    const text = section && !m.message.includes('docs/conventions.md') ? `${m.message} ${see(section)}` : m.message

    counts[key] = (counts[key] ?? 0) + 1
    messages.set(key, [...(messages.get(key) ?? []), `${where} ${m.ruleId}: ${text}`])
  }
}

for (const b of broken) {
  console.error(b)
}

if (!process.argv.includes('--update')) {
  for (const [key, count] of Object.entries(counts)) {
    if (count > (LEGACY[key] ?? 0)) {
      console.error(messages.get(key).join('\n'))
    }
  }
}

ratchet({ counts, file: FILE, items: 'file-rule pairs', limit: 0, name: 'lint', unit: 'errors' })

if (broken.length) {
  console.error(`lint: ${broken.length} error(s) with no rule (a parse error, an unused eslint-disable); the legacy list cannot hold them`)
  process.exit(1)
}
