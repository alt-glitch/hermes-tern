// Hermes for Tern. Asks the terminal for the Tern Surface Protocol; without it
// exits with NO_TSP so the launcher falls back to the Ink TUI. With it, starts
// the gateway (python -m tui_gateway.entry, or HERMES_TUI_GATEWAY_URL) and
// runs the app until the user quits: the chat, or (opened as a sidebar by the
// chat) one subagent's pane.

import { connect } from '@stencil-hq/tern'
import { GatewayClient } from '@tui/gatewayClient.js'

import { App } from './app.js'
import { readWatchSpec } from './watch/spec.js'
import { WatchApp } from './watch/watchApp.js'

/** Exit code telling the launcher this terminal doesn't speak TSP. */
export const NO_TSP = 75

const version = process.env.HERMES_VERSION ?? ''
const session = await connect({ app: 'hermes', features: ['edit', 'undo', 'send'], version })

if (!session) {
  process.exit(NO_TSP)
}

const gw = new GatewayClient()
gw.start()

const watch = readWatchSpec()
const app = watch ? new WatchApp(session, gw, watch) : new App(session, gw, version)

// Node exits on an unhandled rejection: a stray failed promise is a notice in the chat, not a closed pane.
process.on('unhandledRejection', reason => {
  if (app instanceof App) {
    app.fault(reason)
  }
})

const code = await app.run()
process.exit(code)
