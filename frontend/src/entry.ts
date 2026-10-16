// Hermes for Tern. Asks the terminal for the Tern Surface Protocol; without it
// exits with NO_TSP so the launcher falls back to the Ink TUI. With it, starts
// the gateway (python -m tui_gateway.entry, or HERMES_TUI_GATEWAY_URL) and
// runs the app until the user quits.

import { connect } from '@stencil-hq/tern'
import { GatewayClient } from '@tui/gatewayClient.js'

import { App } from './app.js'

/** Exit code telling the launcher this terminal doesn't speak TSP. */
export const NO_TSP = 75

const version = process.env.HERMES_VERSION ?? ''
const session = await connect({ app: 'hermes', features: ['edit', 'undo', 'send'], version })

if (!session) {
  process.exit(NO_TSP)
}

const gw = new GatewayClient()
gw.start()

const code = await new App(session, gw, version).run()
process.exit(code)
