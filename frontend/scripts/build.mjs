#!/usr/bin/env node
// The Tern frontend's esbuild recipe: one ESM file for node. `@tui/*` reaches
// the renderer-free modules of ui-tui (gateway transport, skin palette).
// scripts/build/tsp.mjs wraps this into the receipted `tsp` product; run
// directly it is the fast developer build into `dist/entry.js` (or `$TSP_OUT`).
import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Bundles `src/entry.ts` into `outfile`. */
export async function bundle({ outfile, logLevel = 'warning' }) {
  await build({
    absWorkingDir: root,
    entryPoints: [resolve(root, 'src/entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    jsx: 'automatic',
    jsxImportSource: '@stencil-hq/tern',
    loader: { '.png': 'binary' },
    alias: { '@tui': resolve(root, '../ui-tui/src') },
    // CommonJS dependencies (undici) still call require().
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
    },
    logLevel
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await bundle({ outfile: process.env.TSP_OUT ? resolve(process.env.TSP_OUT) : resolve(root, 'dist/entry.js') })
}
