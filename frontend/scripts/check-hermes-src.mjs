#!/usr/bin/env node
// Compares the Hermes checkout `.hermes-src` points at with the commit this frontend is pinned to
// (`hermes-src.lock`). `hermes update` moves that checkout under us, and the bundle inlines its
// ui-tui and apps/shared sources, so a typecheck or test failure after an update may be Hermes'
// change, not ours. A mismatch only warns: bumping Hermes is a deliberate commit that rewrites the
// lock (`git -C .hermes-src rev-parse HEAD > hermes-src.lock`).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const link = resolve(root, '.hermes-src')
const lockFile = resolve(root, 'hermes-src.lock')

if (!existsSync(link)) {
  console.error('hermes-src: no .hermes-src; run `bun run setup` with HERMES_SRC set to a hermes-agent checkout')
  process.exit(1)
}

const locked = existsSync(lockFile) ? readFileSync(lockFile, 'utf8').trim() : ''

/** `git` in the Hermes checkout; null when it is not a git tree. */
function git(...args) {
  try {
    return execFileSync('git', ['-C', link, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

const head = git('rev-parse', 'HEAD')
// Only the sources the bundle inlines matter.
const dirty = git('status', '--porcelain', '--', 'ui-tui/src', 'apps/shared')

console.log(`hermes-src: lock ${locked || '(none)'}, linked ${head ?? '(not a git checkout)'}${dirty ? ' with local changes' : ''}`)

if (!locked) {
  console.warn('hermes-src: warning: no hermes-src.lock; nothing pins the Hermes this frontend builds against')
} else if (head !== locked) {
  const behind = head ? git('rev-list', '--count', `${head}..${locked}`) : null
  const ahead = head ? git('rev-list', '--count', `${locked}..${head}`) : null
  const distance = ahead !== null && behind !== null ? ` (${ahead} ahead, ${behind} behind)` : ''

  console.warn(`hermes-src: warning: .hermes-src is not at the locked commit${distance}; failures below may be Hermes' change`)
}

if (dirty) {
  console.warn('hermes-src: warning: the checkout has uncommitted changes under ui-tui/src or apps/shared')
}
