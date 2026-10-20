#!/usr/bin/env node
// The strict-error ratchet: what two flags tsconfig does not turn on would report, per src/ file.
// `noPropertyAccessFromIndexSignature` finds the dot reads on untyped bags and
// `exactOptionalPropertyTypes` the optional fields set to undefined (docs/conventions.md, "Index
// signatures and optional fields"). src/ has none of either: strict-ceilings.json is empty, and its
// total only goes down, so no file may gain one. Diagnostics in the Hermes sources (.hermes-src)
// are not ours and are skipped. `--update` lowers the ceilings after a fix.
import { relative, resolve } from 'node:path'

import ts from 'typescript'

import { ratchet, root } from './ratchet.mjs'

const FLAGS = { exactOptionalPropertyTypes: true, noPropertyAccessFromIndexSignature: true }

const config = ts.getParsedCommandLineOfConfigFile(resolve(root, 'tsconfig.json'), FLAGS, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: d => {
    throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'))
  }
})

const program = ts.createProgram({ options: config.options, rootNames: config.fileNames })
const counts = {}

for (const source of program.getSourceFiles()) {
  const path = relative(root, source.fileName)

  if (!path.startsWith('src/')) {
    continue
  }

  const errors = program.getSemanticDiagnostics(source).filter(d => d.category === ts.DiagnosticCategory.Error).length

  if (errors) {
    counts[path] = errors
  }
}

ratchet({ counts, file: resolve(root, 'scripts/strict-ceilings.json'), limit: 0, name: 'check-strict', pooled: true, unit: 'errors' })
