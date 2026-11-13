// What this frontend needs of the gateway, by the names `runtime.describe` lists. A Hermes that
// lacks one is older than the plugin supports: the pane says so once, in place of each feature
// failing on its own with an unknown method.

import { type Requester, rpc } from '../wire/rpc.js'

/** The gateway capabilities every pane relies on. */
export const REQUIRED_CAPABILITIES: readonly string[] = [
  'plugin-rpc-v1', // the plugin's own methods and events (viewers.py, charts.py)
  'session-client-v1', // `client` on session.create
  'session-list-picker-v1', // session.list's picker fields
  'session-list-cursor-v1', // session.list's stored pages (cursor, next_cursor) and query
  'session-transcript-v1' // session.transcript
]

/** The required capabilities this gateway does not list (none: it has them all). */
export async function missingCapabilities(gw: Requester): Promise<string[]> {
  const { capabilities } = await rpc(gw, 'runtime.describe', {})

  return REQUIRED_CAPABILITIES.filter(name => !capabilities.includes(name))
}

/** What the pane says when the gateway lacks `missing`. */
export function tooOldNotice(missing: readonly string[]): string {
  return `This Hermes is older than hermes tern needs (it lacks ${missing.join(', ')}). Run \`hermes update\`, then start \`hermes tern\` again.`
}
