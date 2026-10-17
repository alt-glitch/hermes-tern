// `manage_connections` without its card. Hermes draws the connection card only where a surface
// answers `connection.request` (the desktop, the Ink TUI's own gateway); on the shared gateway the
// tool takes its no-card path (tools/connectors/managed.py `_no_card_result`): it returns at once
// with each app's `connect_url`, and nothing watches the authorizations. For a session this pane
// shows, the plugin's Python half (connections.py, a `transform_tool_result` hook) keeps the links
// out of the model's context, writes the apps and their links to
// `plugin-data/hermes-tern/connections/<call id>.json` and watches the connector list, writing
// each app's state there. The pane draws that file as the desktop's card: an Authorize button
// per app, the states as they change, and the agent told as soon as every app is connected.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { appTitle } from './bridge.js'
import type { ToolCall } from './model.js'
import { record } from './transcript.js'

export const CONNECT_TOOL = 'manage_connections'

/** How often the pane reads the card file while an app waits, and for how long at most. */
export const POLL_MS = 2000
export const POLL_FOR_MS = 16 * 60_000

const dataDir = (env: NodeJS.ProcessEnv = process.env) => join(env.HERMES_HOME || join(homedir(), '.hermes'), 'plugin-data', 'hermes-tern')

/** The card the plugin's watcher keeps for call `id`: the apps, their links and states. */
export interface CardFile {
  targets: unknown[]
  /** The watcher still reads the connector list. */
  watching: boolean
  error?: string
}

export function readCard(id: string, dir = dataDir()): CardFile | undefined {
  try {
    const data = JSON.parse(readFileSync(join(dir, 'connections', `${id}.json`), 'utf8')) as Partial<CardFile>

    return Array.isArray(data.targets) ? { error: data.error, targets: data.targets, watching: data.watching === true } : undefined
  } catch {
    return undefined
  }
}

/**
 * Tells the plugin's Python half that this pane shows session `sid` (and stops claiming `previous`),
 * so its connect results come here as a card. The marker names this process; a dead one counts for nothing.
 */
export function markViewer(sid: string | null, previous: string | null, dir = dataDir()) {
  const viewers = join(dir, 'viewers')

  try {
    if (previous && previous !== sid) {
      rmSync(join(viewers, `${previous}.json`), { force: true })
    }

    if (sid) {
      mkdirSync(viewers, { recursive: true })
      writeFileSync(join(viewers, `${sid}.json`), JSON.stringify({ pid: process.pid }))
    }
  } catch {
    // Without the marker, connect results keep the tool's own links: the card still reads them.
  }
}

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
export function connectTargets(call: Pick<ToolCall, 'id' | 'name' | 'result'>, card?: CardFile): ConnectTarget[] {
  if (call.name !== CONNECT_TOOL) {
    return []
  }

  // The watcher's file carries the links (kept out of the model's result) and the live states.
  const targets = card?.targets ?? record(call.result)?.targets

  return parseTargets(Array.isArray(targets) ? targets : [])
}

function parseTargets(targets: unknown[]): ConnectTarget[] {
  return targets.flatMap(t => {
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

/** The call draws the connect card: it carries at least one link to authorize (here, or in its card file). */
export function isConnectCall(call: Pick<ToolCall, 'connect' | 'id' | 'name' | 'result'>): boolean {
  return (call.connect ?? connectTargets(call)).some(t => t.url)
}

const and = (names: string[]) => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`)

/** What Continue sends: the apps the user authorized, in the words the tool's note expects. */
export function continueMessage(targets: readonly ConnectTarget[]): string {
  const names = targets.filter(t => t.state === 'connected' || waiting(t)).map(t => t.title)

  return `I've authorized ${and(names) || 'the apps'}. Check with manage_connections status and carry on.`
}

/** What the pane sends by itself once the watcher saw every app connect, as the desktop's card settles the call. */
export function connectedMessage(targets: readonly ConnectTarget[]): string {
  return `${and(targets.filter(t => t.state === 'connected').map(t => t.title))} ${targets.length === 1 ? 'is' : 'are'} connected now. Carry on.`
}
