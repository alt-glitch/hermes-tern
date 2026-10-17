// `manage_connections` without its card. Hermes draws the connection card only where a surface
// answers `connection.request` (the desktop, the Ink TUI's own gateway); on the shared gateway the
// tool takes its no-card path (tools/connectors/managed.py `_no_card_result`): it returns at once
// with each app's `connect_url` and tells the agent to show the links and to check `status` when the
// user says they are done. The agent often goes on without repeating the links, so the plugin
// draws them: a card per call with an Authorize button per app, the app's state kept current from
// `connectors.list`, and a Continue button that tells the agent which apps the user authorized.

import { appTitle } from './bridge.js'
import type { ToolCall } from './model.js'
import { record } from './transcript.js'

export const CONNECT_TOOL = 'manage_connections'

/** Every 4 s while a link waits, for 15 minutes at most (links expire well before). */
export const POLL_MS = 4000
export const POLL_FOR_MS = 15 * 60_000

/** One app the call asked the user to authorize. */
export interface ConnectTarget {
  name: string
  /** `Google Drive`. */
  title: string
  alias?: string
  /** pending, initiated, connected, skipped, failed, expired, not_connected. */
  state: string
  url?: string
  detail?: string
}

/** The apps a no-card `manage_connections` result asks the user to authorize; none for other calls. */
export function connectTargets(call: Pick<ToolCall, 'name' | 'result'>): ConnectTarget[] {
  if (call.name !== CONNECT_TOOL) {
    return []
  }

  const targets = record(call.result)?.targets

  return (Array.isArray(targets) ? targets : []).flatMap(t => {
    const r = record(t)
    const name = typeof r?.name === 'string' ? r.name : ''

    return name
      ? [
          {
            alias: typeof r?.alias === 'string' && r.alias ? r.alias : undefined,
            detail: typeof r?.detail === 'string' && r.detail ? r.detail : undefined,
            name,
            state: typeof r?.state === 'string' ? r.state : 'pending',
            title: appTitle(name),
            url: typeof r?.connect_url === 'string' && r.connect_url ? r.connect_url : undefined
          }
        ]
      : []
  })
}

/** A target still waiting on the user (a link to open, or a link already opened). */
export const waiting = (t: ConnectTarget) => t.state === 'initiated' || t.state === 'pending'

/** The call draws the connect card: it carries at least one link to authorize. */
export function isConnectCall(call: Pick<ToolCall, 'name' | 'result'>): boolean {
  return connectTargets(call).some(t => t.url)
}

/** `connectors.list` rows folded onto `targets`: an app the gateway reports connected is connected. */
export function applyStatus(targets: ConnectTarget[], rows: readonly { connector?: string; connected?: boolean; connection_status?: string | null }[]): ConnectTarget[] {
  const byName = new Map(rows.map(r => [String(r.connector ?? '').toLowerCase(), r]))

  return targets.map(t => {
    const row = byName.get(t.name.toLowerCase())

    if (!row || !waiting(t)) {
      return t
    }

    if (row.connected) {
      return { ...t, state: 'connected' }
    }

    return row.connection_status === 'failed' || row.connection_status === 'expired' ? { ...t, state: row.connection_status } : t
  })
}

/** What Continue sends: the apps the user authorized, in the words the tool's note expects. */
export function continueMessage(targets: readonly ConnectTarget[]): string {
  const names = targets.filter(t => t.state === 'connected' || waiting(t)).map(t => t.title)
  const list = names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

  return `I've authorized ${list || 'the apps'}. Check with manage_connections status and carry on.`
}
