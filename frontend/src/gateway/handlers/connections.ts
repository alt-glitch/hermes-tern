// The connect card on the shared gateway: `connection.request` opens a `manage_connections`
// operation's card on the call that opened it, and `connection.update` moves its rows or settles it
// (connections/live.ts reads both). The watcher owns the cards; these only hand it the payloads.

import type { ConnectWatcher } from '../../connections/watcher.js'
import type { Handlers } from '../dispatch.js'

/** What the connection events reach of the app. */
export interface ConnectionsCx {
  readonly connect: Pick<ConnectWatcher, 'request' | 'update'>
}

/** The connection events; the watcher asks for a render when a card changed. */
export const connectionHandlers = {
  'connection.request': (ev, cx) => {
    cx.connect.request(ev.payload, ev.session_id)

    return 'quiet'
  },

  'connection.update': (ev, cx) => {
    cx.connect.update(ev.payload, ev.session_id)

    return 'quiet'
  }
} satisfies Handlers<ConnectionsCx>
