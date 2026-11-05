#!/usr/bin/env node
// Explicit prepare-only entrypoint for the unmodified reviewed donor CLI.
// No dependency install, renderer installation, control input or publication.
const args = process.argv.slice(2)

// `prepare-intent` compiles an ephemeral-intent/v1 board against the host intent document (key "z0").
// `prepare-architecture` compiles a read-only ephemeral-architecture/v0 board (key "arch").
if (args.length !== 6 || !['prepare', 'prepare-intent', 'prepare-architecture'].includes(args[0]) || args[5] !== '--json') {
  console.error('Usage: node openui/prepare.mjs prepare|prepare-intent|prepare-architecture <program.openui> <host-document.json> <scope-json> <output-dir> --json')
  process.exitCode = 1
} else {
  // The real @openuidev/lang-core parser is used, with telemetry off before
  // its module is imported. The donor's own strict static checks still apply.
  process.env.OPENUI_TELEMETRY_DISABLED = '1'
  process.env.DO_NOT_TRACK = '1'
  await import('./openui-preview/cli.mjs')
}
