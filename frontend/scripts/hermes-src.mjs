#!/usr/bin/env node
// Points `.hermes-src` at the Hermes checkout the frontend compiles against
// ($HERMES_SRC). The bundle inlines that checkout's renderer-free ui-tui
// modules (gateway client, skins) and apps/shared, so build against the Hermes
// release the plugin targets.
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const link = resolve(root, '.hermes-src')
const wanted = process.env.HERMES_SRC ? resolve(process.env.HERMES_SRC) : null
const current = existsSync(link) && lstatSync(link).isSymbolicLink() ? resolve(root, readlinkSync(link)) : null
const src = wanted ?? current

if (!src) {
  console.error('hermes-src: set HERMES_SRC to a hermes-agent checkout')
  process.exit(1)
}

for (const needed of ['ui-tui/src/gatewayClient.ts', 'apps/shared/package.json']) {
  if (!existsSync(resolve(src, needed))) {
    console.error(`hermes-src: ${src} has no ${needed}; not a hermes-agent checkout`)
    process.exit(1)
  }
}

if (src !== current) {
  rmSync(link, { force: true })
  symlinkSync(src, link, 'dir')
}

let sha = 'unknown'

try {
  sha = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
} catch {
  // A source tree without git still builds; the bundle just carries no pin.
}

console.log(`hermes-src: ${src} @ ${sha}`)
