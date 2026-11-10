#!/usr/bin/env node
// The Tern frontend's esbuild recipe: one self-contained ESM file for node.
// `@hermes/shared` (the gateway client, its types, skins) comes from apps/shared in
// the Hermes checkout `.hermes-src` points at (scripts/hermes-src.mjs).
// Output: `dist/entry.js` (or `$TSP_OUT`).
import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Bundles `src/entry.ts` into `outfile`; `metafile`: the result carries esbuild's input and output map. */
export async function bundle({ outfile, logLevel = 'warning', metafile = false }) {
  return build({
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
    // `@hermes/shared` is a link into the Hermes checkout: keep its files under this package.
    preserveSymlinks: true,
    // A CommonJS dependency may still call require().
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
    },
    logLevel,
    metafile
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await bundle({ outfile: process.env.TSP_OUT ? resolve(process.env.TSP_OUT) : resolve(root, 'dist/entry.js') })
}
