// The connect card as the shared gateway sends it. On every turn a local viewer runs, the gateway
// installs `agent.connection_callback` (hermes-agent gateway/local_desktop_ui.py `wire`), so a
// `manage_connections` connect opens an operation and its tool thread waits on it
// (tools/connectors/run.py `run_operation`) until every app is resolved, the card says Continue, the
// turn stops, or OPERATION_DEADLINE_SECONDS (tools/connectors/operation.py) pass. The pane hears:
//
// - `connection.request`: the operation opened (`ConnectionOperation.request_payload`: op_id, seq,
//   deadline_at, timeout_seconds, each target's snapshot with its link, tool_call_id);
// - `connection.update`: a row moved or the operation settled, with the full snapshot and its seq
//   (local_desktop_ui.py `_install_connection_hook`);
// - a resume's `pending_connection`: the open operation, as `connection.request` sent it.
//
// It answers through gateway/session_connections.py: `connection.respond` (a skip, an approval,
// Continue), `connectors.operation.wake` (read the accounts now), `connectors.connect` with
// `reconnect` (Try again), and reads `connectors.operation.status`. This module reads the payloads
// into the card model the file path draws too (cards.ts) and builds those methods' params; the
// watcher holds the calls and sends them.

import type {
  ConnectionAnswer,
  ConnectionOperationParams,
  ConnectionRespondParams,
  ConnectorsConnectParams
} from '@hermes/shared/gateway-events'

import { record } from '../wire/json.js'

import { type ConnectCard, type ConnectTarget, type LiveOp, parseTargets, type SettleReason, unresolved } from './cards.js'

/** How long the gateway waits when a payload does not say (operation.py OPERATION_DEADLINE_SECONDS). */
export const DEFAULT_TIMEOUT_S = 300

/** A live card read from a payload, and the tool call that opened its operation. */
export interface LiveCard {
  card: ConnectCard & { op: LiveOp }
  /** The model's id for the call; none on a payload that does not say (a missed request's update). */
  callId: string | undefined
}

/** A number, else undefined. */
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * The card a `connection.request` payload, a resume's `pending_connection` or (for an operation the
 * pane missed opening) a `connection.update` frame opens for session `session`; undefined when it
 * names no operation or no app to draw (a desktop-only directory or catalog card).
 */
export function liveCard(payload: unknown, session: string): LiveCard | undefined {
  const r = record(payload)
  const id = typeof r?.['op_id'] === 'string' ? r['op_id'] : ''
  const seq = num(r?.['seq'])
  const deadlineAt = num(r?.['deadline_at'])
  const targets = parseTargets(Array.isArray(r?.['targets']) ? r['targets'] : [])

  if (!r || !id || seq === undefined || !deadlineAt || !targets.length || targets.some(t => t.kind === 'plugin' || t.kind === 'skill')) {
    return undefined
  }

  const callId = typeof r['tool_call_id'] === 'string' && r['tool_call_id'] ? r['tool_call_id'] : undefined
  const op: LiveOp = { deadlineAt, id, seq, session, timeoutSeconds: num(r['timeout_seconds']) ?? DEFAULT_TIMEOUT_S }

  return { callId, card: { op, opened: [], settled: settledBy(r), targets, told: false } }
}

/**
 * `card` after a frame of its operation: a `connection.update`, a `connectors.operation.status` or
 * `connectors.connect` reply, or the tool's own settled result. Undefined when the frame moves
 * nothing: another operation's, one no newer than the card (the transport may reorder them), or a
 * card already settled. A frame's row without a link keeps the one the card has (the model's
 * result carries none).
 */
export function applyFrame(card: ConnectCard, frame: unknown): ConnectCard | undefined {
  const r = record(frame)
  const op = card.op
  const seq = num(r?.['seq'])

  if (!r || !op || card.settled || r['op_id'] !== op.id || seq === undefined || seq <= op.seq) {
    return undefined
  }

  const rows = Array.isArray(r['targets']) ? parseTargets(r['targets']) : []
  const before = new Map(card.targets.map(t => [t.name, t]))
  const targets = rows.length ? rows.map(t => ({ ...t, url: t.url ?? before.get(t.name)?.url })) : card.targets

  return { ...card, op: { ...op, deadlineAt: num(r['deadline_at']) ?? op.deadlineAt, seq }, settled: settledBy(r), targets }
}

/** Why a frame says its operation settled (its `settled_by`, as cards.ts words it); undefined while it is open. */
function settledBy(r: Record<string, unknown>): SettleReason | undefined {
  if (r['settled'] !== true && num(r['settled_at']) === undefined) {
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

/** What a live row's button does: open its link, start an MCP install, run a dead link again, or nothing. */
export type Verb = 'approve' | 'none' | 'open' | 'retry'

/** The desktop's verbs (connector-tool.tsx CONNECTOR_CARD_PHASES), and the Ink TUI's Connect for an MCP row. */
export function verbOf(t: ConnectTarget): Verb {
  switch (t.state) {
    case 'pending':
      // An MCP row starts on Connect; one that needs a credential this pane cannot ask for only skips.
      return t.kind === 'mcp' ? (t.needs ? 'none' : 'approve') : t.url ? 'open' : 'none'
    case 'initiated':
      return t.url ? 'open' : 'none'
    case 'expired':
    case 'failed':
      return 'retry'
    default:
      return 'none'
  }
}

/** The card is the gateway's and still waits on the user. */
export const liveOpen = (card: ConnectCard | undefined): card is ConnectCard & { op: LiveOp } =>
  Boolean(card?.op && !card.settled && card.targets.some(unresolved))

const owner = (op: LiveOp) => ({ session_id: op.session, type: 'session' as const })

/** `connectors.operation.status` and `connectors.operation.wake`: the operation and its session. */
export const opParams = (op: LiveOp): ConnectionOperationParams => ({ op_id: op.id, owner: owner(op) })

/** `connection.respond`: the card's answer. */
export const respondParams = (op: LiveOp, result: ConnectionAnswer): ConnectionRespondParams => ({ ...opParams(op), result })

/** `connectors.connect` with `reconnect`: Try again on app `name` of the session's open operation. */
export const retryParams = (op: LiveOp, name: string): ConnectorsConnectParams => ({ connectors: [name], owner: owner(op), reconnect: true })

/** The answer each row's button sends. */
export const answers = {
  /** An MCP row's Connect, with the credentials it has defaults for. */
  approve: (t: ConnectTarget): ConnectionAnswer => ({ targets: [{ name: t.name, status: 'approved', ...(t.env ? { env: t.env } : {}) }] }),
  /** Continue: the tool returns now, its unresolved apps not connected. */
  continue: (): ConnectionAnswer => ({ settled_by: 'continue' }),
  skip: (t: Pick<ConnectTarget, 'name'>): ConnectionAnswer => ({ targets: [{ name: t.name, status: 'skipped' }] })
}
