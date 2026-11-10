// `manage_connections`' connect card. The shared gateway installs `agent.connection_callback` on
// every turn a local viewer runs (gateway/local_desktop_ui.py `wire`): the tool opens an operation,
// sends the pane `connection.request` and blocks until the card answers or the deadline passes.
// live.ts reads that wire, and the watcher answers it through the gateway (`connection.respond`,
// `connectors.operation.wake`, `connectors.connect`). This module is the card's model.
//
// The desktop's rules (apps/desktop/src/store/connection-request.ts, connector-tool.tsx) carry over:
// the card is named by its operation, not its call id, as models reuse call ids; the backend alone
// moves a row; a settled card is a static summary with no controls and no polling, its unresolved
// rows not connected.

import type { ToolCall } from '../model.js'
import { appTitle } from '../tools/bridge.js'
import { record } from '../wire/json.js'

export const CONNECT_TOOL = 'manage_connections'

/** How often the pane reads an open card's operation again (a frame it may have missed). */
export const POLL_MS = 2000
/**
 * Why nothing moves a card's rows any more (the desktop's settle reasons): every app resolved, the
 * user pressed Continue, the wait ran out, the user stopped the turn, or it stopped without a word
 * (its gateway, or the gateway's operation, is gone).
 */
export type SettleReason = 'all_resolved' | 'continued' | 'deadline' | 'interrupt' | 'stopped'

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
  /** `connector` (a hosted account) or `mcp` (a local server). */
  kind?: string | undefined
  /** An MCP install's credentials with a default: sent back with Connect. */
  env?: Record<string, string> | undefined
  /** An MCP install's required credentials with no default: this pane cannot ask for them. */
  needs?: string[] | undefined
  /** What approving an MCP row runs or contacts (the gateway's scrubbed `launch` line): shown before Connect. */
  launch?: Launch | undefined
}

/** `Target.launch` (tools/connectors/mcp_launch.py): a command it runs, or an endpoint it connects to. */
export interface Launch {
  kind: 'remote' | 'stdio'
  target: string
  cwd?: string | undefined
  /** The names of the variables it sets; never their values. */
  env?: string[] | undefined
}

/** The gateway's operation behind a live card (live.ts): what its answers name. */
export interface LiveOp {
  /** The operation's id: it names the card, as models reuse call ids. */
  id: string
  /** The newest frame applied; a frame with this seq or an older one moves nothing. */
  seq: number
  /** The runtime id of the session that owns it: every answer names it as the owner. */
  session: string
  /** Epoch seconds the gateway stops waiting: every frame carries it, so the card's wait is right whichever frame drew it. */
  deadlineAt: number
}

/** A connect call's card as the pane last read it. */
export interface ConnectCard {
  /** The gateway's operation while the pane holds it (`connection.request`): the pane answers it. None on a summary read back from the tool's result. */
  op?: LiveOp | undefined
  /** Answers in flight, `<verb>:<app>` (`skip`, `approve`, `retry`) or CONTINUE: their buttons say so and take no second press. */
  sending?: string[] | undefined
  targets: ConnectTarget[]
  /** Nothing moves the rows any more; the card is a summary. */
  settled?: SettleReason | undefined
  /** The apps whose link the user opened from this card: only those wait on the browser. */
  opened: string[]
}

/** The rows of a gateway frame or a settled result (`Target.snapshot`): each app named. */
export function parseTargets(targets: unknown[]): ConnectTarget[] {
  return targets.flatMap(t => {
    const r = record(t)
    const name = typeof r?.['name'] === 'string' ? r['name'].trim() : ''
    const fields = Array.isArray(r?.['required_env']) ? r['required_env'].flatMap(f => envField(f)) : []
    const env = Object.fromEntries(fields.flatMap(f => (f.default ? [[f.name, f.default]] : [])))
    const needs = fields.filter(f => f.required && !f.default).map(f => f.name)

    return name
      ? [
          {
            alias: text(r?.['alias']),
            detail: text(r?.['detail']),
            env: Object.keys(env).length ? env : undefined,
            kind: text(r?.['kind']),
            launch: launchOf(r?.['launch']),
            name,
            needs: needs.length ? needs : undefined,
            state: typeof r?.['state'] === 'string' ? r['state'] : 'pending',
            title: appTitle(name),
            url: text(r?.['connect_url'])
          }
        ]
      : []
  })
}

/** A target's `launch` descriptor, when it names what it runs or contacts. */
function launchOf(raw: unknown): Launch | undefined {
  const r = record(raw)
  const kind = r?.['kind']
  const target = text(r?.['target'])

  if ((kind !== 'remote' && kind !== 'stdio') || !target) {
    return undefined
  }

  const env = Array.isArray(r?.['env']) ? r['env'].filter((k): k is string => typeof k === 'string' && k !== '') : []

  return { cwd: text(r?.['cwd']), env: env.length ? env : undefined, kind, target }
}

/** A non-empty string, else undefined. */
const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

/** One credential an MCP install asks for (`ConnectionTargetEnvField`). */
function envField(raw: unknown): { name: string; required: boolean; default: string }[] {
  const r = record(raw)
  const name = text(r?.['name'])

  return name ? [{ default: typeof r?.['default'] === 'string' ? r['default'] : '', name, required: r?.['required'] === true }] : []
}

/** A target still waiting on the user (a link to open, or a link already opened). */
export const waiting = (t: Pick<ConnectTarget, 'state'>) => t.state === 'initiated' || t.state === 'pending'

/** The `sending` entry of a live card's Continue. */
export const CONTINUE = 'continue'

/** The verb whose answer for app `name` is in flight on `card`, if one is. */
export const sendingVerb = (card: Pick<ConnectCard, 'sending'>, name: string): string | undefined =>
  card.sending?.find(r => r.endsWith(`:${name}`))?.split(':')[0]

/** Every app the card still stands for is connected. */
export const allConnected = (card: ConnectCard) => {
  const own = card.targets.filter(t => t.state !== 'superseded')

  return own.length > 0 && own.every(t => t.state === 'connected')
}

/** Why a gateway frame says its operation settled (its `settled_by`, in this module's words); undefined while it is open. */
export function settleReason(r: Record<string, unknown>): SettleReason | undefined {
  if (r['settled'] !== true && typeof r['settled_at'] !== 'number') {
    return undefined
  }

  switch (r['settled_by']) {
    case 'all_resolved':
    case 'deadline':
    case 'interrupt':
      return r['settled_by']
    case 'continue':
      return 'continued'
    default:
      return 'stopped'
  }
}

/**
 * The summary card a settled operation's tool result reads as (`ConnectionOperation.result`:
 * `status: settled`, its `settled_by` and the rows as they ended). A reloaded call has only this,
 * so its card stays the same summary the live one settled into. Undefined for any other result.
 */
export function resultCard(call: Pick<ToolCall, 'name' | 'result'>): ConnectCard | undefined {
  const r = call.name === CONNECT_TOOL ? record(call.result) : undefined
  const settled = r && r['status'] === 'settled' && typeof r['op_id'] === 'string' ? settleReason(r) : undefined
  const targets = settled && Array.isArray(r?.['targets']) ? parseTargets(r['targets']) : []

  return targets.length ? { opened: [], settled, targets } : undefined
}

/** The card `call` draws: the gateway's operation it holds, else the summary its settled result reads as. */
export const connectCardOf = (call: Pick<ToolCall, 'connect' | 'name' | 'result'>): ConnectCard | undefined => call.connect ?? resultCard(call)

/** The call draws the connect card: the gateway opened its operation (a live card) or settled it (its result). */
export const isConnectCall = (call: Pick<ToolCall, 'connect' | 'name' | 'result'>): boolean => connectCardOf(call) !== undefined

/** A row the user still has to act on: not connected, skipped, or closed by the settle. */
export const unresolved = (t: Pick<ConnectTarget, 'state'>) => ['expired', 'failed', 'initiated', 'pending'].includes(t.state)

/** The name a card's buttons send: its operation, else its call. */
export const cardRef = (call: Pick<ToolCall, 'connect' | 'id'>): string => call.connect?.op?.id ?? call.id
