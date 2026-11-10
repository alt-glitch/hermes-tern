// Hermes for Tern. Asks the terminal for the Tern Surface Protocol; without it
// exits with NO_TSP, and the launcher tells the user this is not a Tern pane. With it, attaches
// to the profile's gateway (`hermes gateway attach`, hermes/connect.ts) and
// runs the app until the user quits: the chat, or (opened as a sidebar by the
// chat) one subagent's pane.

import { connect } from '@stencil-hq/tern'

import { App } from './app/chat.js'
import { FaultBudget, isDeadStream } from './chrome/backendNotes.js'
import { launchEnv } from './config/env.js'
import { createGatewayClient } from './hermes/gatewayClient.js'
import { fileSettings } from './settings.js'
import { readWatchSpec } from './watch/spec.js'
import { WatchApp } from './watch/watchApp.js'

/** Exit code telling the launcher this terminal doesn't speak TSP. */
export const NO_TSP = 75

// The environment and the settings file, read once here and handed to the app.
const launch = launchEnv()
const settings = fileSettings()
const session = await connect({ app: 'hermes', features: ['edit', 'undo', 'send'] })

if (!session) {
  process.exit(NO_TSP)
}

const gw = createGatewayClient(launch)
gw.start()

const watch = readWatchSpec()
const app = watch ? new WatchApp(session, gw, watch, settings) : new App(session, gw, '', { launch, settings })

// Node exits on an unhandled rejection or throw: a stray one is a notice in the chat, not a closed
// pane, as Ink's setupGracefulExit does. A closed terminal (EIO, EPIPE) can show nothing, and a
// fault that repeats itself (a throwing render) would only loop, so those exit.
const faults = new FaultBudget()
const fault = (err: unknown) => {
  if (!(app instanceof App) || isDeadStream(err) || !faults.take()) {
    process.stderr.write(`hermes tern: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    gw.kill('exit')
    process.exit(1)
  }

  app.fault(err)
}

process.on('unhandledRejection', fault)
process.on('uncaughtException', fault)

const code = await app.run()
process.exit(code)
