// The gateway client: Hermes' shared Node client (`@hermes/shared/gateway-client`), dialing the
// profile's gateway with the attach grant connect.ts gets. entry.ts makes one per pane.

import { GatewayClient } from '@hermes/shared/gateway-client'

import pkg from '../../package.json' with { type: 'json' }
import type { LaunchEnv } from '../config/env.js'

import { AttachError, attachGateway, terminalAttachFailure } from './connect.js'

export { GatewayClient }

/** How this client names itself on `session.create`: the gateway keeps it with the session (`session.info.client`). */
export const CLIENT = { name: 'hermes-tern', version: pkg.version }

/** A client for `launch`'s Hermes, pinning the launch's tool-progress mode on each new session. */
export function createGatewayClient(launch: Pick<LaunchEnv, 'hermes' | 'toolProgress'>): GatewayClient {
  const connect = launch.hermes
    ? attachGateway(launch.hermes)
    : () => Promise.reject(new AttachError('gateway unavailable: start the chat with `hermes tern`', true))

  return new GatewayClient({
    client: CLIENT,
    connect,
    terminalConnectFailure: terminalAttachFailure,
    toolProgress: () => launch.toolProgress || undefined
  })
}
