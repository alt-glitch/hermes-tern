// `manage_connections` without its card. Hermes draws the connection card only where a surface
// answers `connection.request` (the desktop, the Ink TUI's own gateway); on the shared gateway the
// tool takes its no-card path (tools/connectors/managed.py `_no_card_result`): it returns at once
// with each app's `connect_url`, and nothing watches the authorizations. For a session this pane
// shows, the plugin's Python half (connections.py, a `transform_tool_result` hook) keeps the links
// out of the model's context, writes the apps and their links to
// `plugin-data/hermes-tern/connections/<call id>.<op id>.json` and watches the user's accounts,
// writing each app's state there. The pane draws that file as the desktop's card: an Authorize
// button per app, the states as they change, and the agent told as soon as every app is connected.
//
// The desktop's rules (apps/desktop/src/store/connection-request.ts, connector-tool.tsx) carry over:
// the card is named by its operation, not its call id, as models reuse call ids; the backend alone
// moves a row; a newer call for the same account replaces the card; a settled card is a static
// summary with no controls and no polling, its unresolved rows not connected.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { appTitle } from './bridge.js'
import { errorCode } from './core/errors.js'
import type { DurableSessionId } from './core/ids.js'
import { attempt } from './core/result.js'
import type { ToolCall } from './model.js'
import { cardCreatedAt, readCardFile } from './wire/files.js'
import { record } from './wire/json.js'

export const CONNECT_TOOL = 'manage_connections'

/** How often the pane reads the card file while an app waits. */
export const POLL_MS = 2000
/**
 * A watching card whose file has not moved for this long has no watcher: its gateway restarted or
 * hung. The watcher writes every few seconds; one slow connector read can hold it for a minute.
 */
export const STALE_MS = 2 * 60_000

export const dataDir = (env: NodeJS.ProcessEnv = process.env) => join(env['HERMES_HOME'] || join(homedir(), '.hermes'), 'plugin-data', 'hermes-tern')

/**
 * Why nothing moves a card's rows any more (the desktop's settle reasons, and the plugin's own):
 * every app resolved, the user pressed Continue, the 15 minutes ran out, a newer call asked for its
 * apps again, the watcher failed, or it stopped without a word (its gateway is gone).
 */
export type SettleReason = 'all_resolved' | 'continued' | 'deadline' | 'error' | 'stopped' | 'superseded'

/** The card the plugin's watcher keeps for one call: the apps, their links and states. */
export interface CardFile {
  /** Its name without `.json`: `<call id>.<op id>`, or `<call id>` from before cards had an op. */
  key: string
  targets: unknown[]
  settled?: SettleReason | undefined
  error?: string | undefined
  /** A pane already told the agent about it (its Continue, or every app connected). */
  told: boolean
}

/** connections.py `_safe`: the file name's parts. */
const safe = (part: string) => part.replace(/[^A-Za-z0-9_-]/g, '_')

export const cardStem = (callId: string, opId?: string) => (opId ? `${safe(callId)}.${safe(opId)}` : safe(callId))

/** Whether process `pid` runs (as this user or another); a card that names none counts as alive. */
const alive = (pid: number | undefined) => {
  if (pid === undefined) {
    return true
  }

  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return errorCode(error) === 'EPERM'
  }
}

export function readCard(key: string, dir = dataDir(), now = Date.now()): CardFile | undefined {
  const data = readCardFile(join(dir, 'connections', `${key}.json`))

  if (!data) {
    return undefined
  }

  const error = data.error || undefined
  const updated = data.updated_at === undefined ? now : data.updated_at * 1000
  let settled: SettleReason | undefined

  if (data.settled_by) {
    settled = data.settled_by
  } else if (data.watching !== true) {
    // A card from before `settled_by`: it stopped at the end, or on an error.
    settled = error ? 'error' : data.targets.some(t => waiting({ state: String(record(t)?.['state'] ?? '') })) ? 'deadline' : 'all_resolved'
  } else if (!alive(data.pid) || now - updated > STALE_MS) {
    settled = 'stopped'
  }

  return { error, key, settled, targets: data.targets, told: existsSync(join(dir, 'connections', `${key}.told`)) }
}

/**
 * The card file of `call`. The live result names its operation (`op_id`); a stored call comes back
 * without its result, so it goes by its call id: the one card of that id, or, as a model reuses call
 * ids, the one written closest to when the call ran.
 */
export function findCard(call: Pick<ToolCall, 'id' | 'result' | 'startedAt'>, dir = dataDir()): string | undefined {
  const op = record(call.result)?.['op_id']
  const prefix = `${safe(call.id)}.`

  // A call that names its operation draws that card and no other.
  if (typeof op === 'string' && op) {
    return existsSync(join(dir, 'connections', `${cardStem(call.id, op)}.json`)) ? cardStem(call.id, op) : undefined
  }

  let names: string[]

  try {
    names = readdirSync(join(dir, 'connections'))
  } catch {
    return undefined
  }

  const keys = names.flatMap(n => {
    const key = n.endsWith('.json') ? n.slice(0, -5) : ''

    return key === safe(call.id) || (key.startsWith(prefix) && !key.slice(prefix.length).includes('.')) ? [key] : []
  })

  if (keys.length < 2) {
    return keys[0]
  }

  const createdAt = (key: string) => cardCreatedAt(join(dir, 'connections', `${key}.json`)) * 1000

  return keys.map(key => ({ gap: Math.abs(createdAt(key) - call.startedAt), key })).sort((a, b) => a.gap - b.gap)[0]?.key
}

/**
 * Who tells the agent about a card: this pane (`claimed`), a pane that claimed it first (`taken`),
 * or nobody knows, as the claim could not be written (`failed`: no folder, no permission).
 */
export type Claim = { kind: 'claimed' } | { kind: 'taken' } | { kind: 'failed'; error: unknown }

/** Records that a pane told the agent about card `key`; `taken` when one already had (two panes, one message). */
export function claimTold(key: string, dir = dataDir()): Claim {
  const claim = attempt(() => writeFileSync(join(dir, 'connections', `${key}.told`), '', { flag: 'wx' }))

  if (claim.kind === 'ok') {
    return { kind: 'claimed' }
  }

  return errorCode(claim.error) === 'EEXIST' ? { kind: 'taken' } : { error: claim.error, kind: 'failed' }
}

/** Whether this pane tells the agent about `card`: no other pane claimed it (a claim it cannot write tells all the same). */
export function mayTell(card: Pick<ConnectCard, 'key'>, dir = dataDir()): boolean {
  return !card.key || claimTold(card.key, dir).kind !== 'taken'
}

/** The Tern variables that name this pane, its window and their sockets: the agent's tools get them, so `tern` finds this pane. */
export const TERN_PANE_VARS = ['TERN_PANE', 'TERN_PANE_SOCKET', 'TERN_WINDOW_KEY', 'TERN_WINDOW_SOCKET', 'TERN_DAEMON_SOCKET'] as const

/** This pane's Tern variables (only the set ones), or undefined outside a Tern pane. */
export function ternPane(env: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  const vars = Object.fromEntries(TERN_PANE_VARS.flatMap(k => (env[k] ? [[k, env[k]]] : [])))

  return vars['TERN_PANE'] ? vars : undefined
}

/**
 * Tells the plugin's Python half that this pane shows session `sid` (and stops claiming `previous`),
 * so its connect results come here as a card and the agent's `tern` commands find this pane. The
 * marker names this process; a dead one counts for nothing.
 */
export function markViewer(sid: DurableSessionId | null, previous: DurableSessionId | null, dir = dataDir(), env: NodeJS.ProcessEnv = process.env) {
  const viewers = join(dir, 'viewers')

  try {
    if (previous && previous !== sid) {
      rmSync(join(viewers, `${previous}.json`), { force: true })
    }

    if (sid) {
      mkdirSync(viewers, { recursive: true })
      writeFileSync(join(viewers, `${sid}.json`), JSON.stringify({ pid: process.pid, tern: ternPane(env) }))
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
  alias?: string | undefined
  /** pending, initiated, connected, skipped, failed, expired, not_connected, superseded. */
  state: string
  url?: string | undefined
  detail?: string | undefined
}

/** A connect call's card as the pane last read it. */
export interface ConnectCard {
  /** Its file (`CardFile.key`); none when the call's own result carries the links. */
  key?: string | undefined
  targets: ConnectTarget[]
  /** Nothing moves the rows any more; the card is a summary. */
  settled?: SettleReason | undefined
  error?: string | undefined
  /** The agent was told (this pane's Continue or its message, or another pane's). */
  told: boolean
  /** The apps whose link the user opened from this card: only those wait on the browser. */
  opened: string[]
}

/** The apps a no-card `manage_connections` result asks the user to authorize; none for other calls. */
export function connectTargets(call: Pick<ToolCall, 'name' | 'result'>, card?: Pick<CardFile, 'targets'>): ConnectTarget[] {
  if (call.name !== CONNECT_TOOL) {
    return []
  }

  // The watcher's file carries the links (kept out of the model's result) and the live states.
  const targets = card?.targets ?? record(call.result)?.['targets']

  return parseTargets(Array.isArray(targets) ? targets : [])
}

/** `call`'s card: its file when the watcher keeps one, else its own result (links there, nothing watching). */
export function loadConnect(call: ToolCall, dir = dataDir(), now = Date.now()): ConnectCard | undefined {
  if (call.name !== CONNECT_TOOL) {
    return undefined
  }

  const key = call.connect?.key ?? findCard(call, dir)
  const file = key ? readCard(key, dir, now) : undefined
  const targets = connectTargets(call, file)

  if (!targets.length) {
    return undefined
  }

  return {
    error: file?.error,
    key: file?.key,
    opened: call.connect?.opened ?? [],
    // Continue settles the card at once, as on the desktop; the watcher sees the claim on its next read.
    settled: file?.settled ?? (file?.told || call.connect?.told ? 'continued' : undefined),
    targets,
    told: Boolean(file?.told || call.connect?.told)
  }
}

function parseTargets(targets: unknown[]): ConnectTarget[] {
  return targets.flatMap(t => {
    const r = record(t)
    const name = typeof r?.['name'] === 'string' ? r['name'] : ''

    return name
      ? [
          {
            alias: typeof r?.['alias'] === 'string' && r['alias'] ? r['alias'] : undefined,
            detail: typeof r?.['detail'] === 'string' && r['detail'] ? r['detail'] : undefined,
            name,
            state: typeof r?.['state'] === 'string' ? r['state'] : 'pending',
            title: appTitle(name),
            url: typeof r?.['connect_url'] === 'string' && r['connect_url'] ? r['connect_url'] : undefined
          }
        ]
      : []
  })
}

/** A target still waiting on the user (a link to open, or a link already opened). */
export const waiting = (t: Pick<ConnectTarget, 'state'>) => t.state === 'initiated' || t.state === 'pending'

/** Every app the card still stands for is connected. */
export const allConnected = (card: ConnectCard) => {
  const own = card.targets.filter(t => t.state !== 'superseded')

  return own.length > 0 && own.every(t => t.state === 'connected')
}

/**
 * The call draws the connect card: it carries at least one link to authorize (here, or in its card
 * file). A card a newer call replaced draws none, as on the desktop: its row is the plain tool call.
 */
export function isConnectCall(call: Pick<ToolCall, 'connect' | 'name' | 'result'>): boolean {
  const card = call.connect

  return card ? card.settled !== 'superseded' && card.targets.some(t => t.url) : connectTargets(call).some(t => t.url)
}

const and = (names: string[]) => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`)

/** What Continue sends: the apps the user authorized, in the words the tool's note expects. */
export function continueMessage(targets: readonly ConnectTarget[]): string {
  const names = targets.filter(t => t.state === 'connected' || waiting(t)).map(t => t.title)

  return `I've authorized ${and(names) || 'the apps'}. Check with manage_connections status and carry on.`
}

/** What the pane sends by itself once the watcher saw every app connect, as the desktop's card settles the call. */
export function connectedMessage(targets: readonly ConnectTarget[]): string {
  const names = targets.filter(t => t.state === 'connected').map(t => t.title)

  return `${and(names)} ${names.length === 1 ? 'is' : 'are'} connected now. Carry on.`
}
