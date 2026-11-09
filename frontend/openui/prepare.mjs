#!/usr/bin/env node
// Explicit prepare-only entrypoint; no renderer, permissions or card actions run.
const args = process.argv.slice(2)

// `prepare-intent` compiles an ephemeral-intent/v1 board against the host intent document (key "z0").
// `prepare-architecture` compiles a read-only ephemeral-architecture/v0 board (key "arch").
if (args[0] === 'prepare-card') {
  if (args.length !== 5 || args[4] !== '--json') {
    console.error('Usage: node openui/prepare.mjs prepare-card <card.json> <scope-json> <absolute-output-dir> --json')
    process.exitCode = 1
  } else {
    try {
      const { prepareCardFile } = await import('./card.mjs')
      const notice = await prepareCardFile(args[1], args[2], args[3])
      process.stdout.write(JSON.stringify(notice) + '\n')
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Card preparation failed.')
      process.exitCode = 1
    }
  }
} else if (args.length !== 6 || !['prepare', 'prepare-intent', 'prepare-architecture'].includes(args[0]) || args[5] !== '--json') {
  console.error('Usage: node openui/prepare.mjs prepare|prepare-intent|prepare-architecture <program.openui> <host-document.json> <scope-json> <output-dir> --json')
  process.exitCode = 1
} else {
  // The reviewed donor parser still handles the existing two preview commands.
  process.env.OPENUI_TELEMETRY_DISABLED = '1'
  process.env.DO_NOT_TRACK = '1'
  await import('./openui-preview/cli.mjs')
}
