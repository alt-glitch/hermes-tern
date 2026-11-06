// The gateway client: Hermes' shared Node client (`@hermes/shared/gateway-client`), dialing the
// profile's gateway with the attach grant connect.ts gets. entry.ts makes one per pane.

import { GatewayClient } from '@hermes/shared/gateway-client'

import type { LaunchEnv } from '../config/env.js'

import { AttachError, attachGateway, terminalAttachFailure } from './connect.js'

export { GatewayClient }

/** A client for `launch`'s Hermes, pinning the launch's tool-progress mode on each new session. */
export function createGatewayClient(launch: Pick<LaunchEnv, 'hermes' | 'toolProgress'>): GatewayClient {
  const connect = launch.hermes
    ? attachGateway(launch.hermes)
    : () => Promise.reject(new AttachError('gateway unavailable: start the chat with `hermes tern`', true))

  return new GatewayClient({ connect, terminalConnectFailure: terminalAttachFailure, toolProgress: () => launch.toolProgress || undefined })
}
