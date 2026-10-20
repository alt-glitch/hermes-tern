// The session's reasoning as thought rows. The shared gateway streams a session's reasoning only
// to a viewer that asks (a session flag, not a settings write); the work log shows it as thought
// rows. settings.json's `thoughts: false` keeps them off.

import type { GatewayClient } from '@tui/gatewayClient.js'

import type { ChatPorts } from '../app/ports.js'
import type { LiveSessionId } from '../core/ids.js'
import type { SettingsSource } from '../settings.js'
import { rpc } from '../wire/rpc.js'

/** What turning on thoughts reaches of the app. */
export type ThoughtsHost = Pick<ChatPorts, 'notice'> & {
  readonly gw: Pick<GatewayClient, 'request'>
  /** Read again for each session: the panes of a profile share the file. */
  readonly settings: Pick<SettingsSource, 'load'>
}

/** Asks the gateway to stream session `sid`'s reasoning, unless the settings turn thoughts off. */
export function showThoughts(host: ThoughtsHost, sid: LiveSessionId) {
  if (host.settings.load().thoughts === false) {
    return
  }

  rpc(host.gw, 'config.set', { key: 'show_reasoning', session_id: sid, value: 'on' }).catch((error: Error) => {
    host.notice(`Could not turn on thoughts: ${error.message}`, 'warning')
  })
}
