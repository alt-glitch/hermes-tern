// A stored conversation read through the gateway's `session.transcript`
// (gateway/session_stored_reads.py): its display rows, as `session.resume` shows them, with its
// compaction handoffs put back as rows of their own (`row_kind: 'compaction'`). The read attaches
// nothing, so the session picker previews a conversation without opening it. Newest first
// (`order: 'latest'`): each next page is older, and `next_cursor` is null after the oldest.

import type { StoredTranscriptResult, StoredTranscriptRow } from '@hermes/shared/gateway-events'

import { type Requester, rpc } from '../wire/rpc.js'

import type { StoredCompaction } from './compactions.js'

/** One line of the preview's transcript. */
export type PreviewRow =
  | { kind: 'user'; key: string; text: string; steer: boolean }
  | { kind: 'assistant'; key: string; text: string }
  | { kind: 'tool'; key: string; name: string; args: Record<string, unknown> }
  | { kind: 'note'; key: string; text: string; tone: 'error' | 'muted' }

/** One page, newest line first: its lines, and the cursor of the next (older) page, null after the oldest. */
export interface TranscriptPage {
  rows: PreviewRow[]
  next: string | null
  /** The gateway restarted the transcript from its newest page: what was held before is stale. */
  reset: boolean
}

/** What the preview reads; the picker's loader takes it so the tests can stand in for the gateway. */
export interface TranscriptReader {
  page(id: string, cursor: string | null, limit: number): Promise<TranscriptPage>
}

/** User rows Hermes writes for the agent, not typed by the user: one line each in the preview. */
const NOTICE_KINDS = new Set(['async_delegation_complete', 'internal_notification', 'model_switch', 'process_complete'])

/** Conversation `id`'s page of up to `limit` rows older than `cursor` (the newest page without one). */
export function readTranscript(gw: Requester, id: string, cursor: string | null, limit: number): Promise<StoredTranscriptResult> {
  return rpc(gw, 'session.transcript', { cursor, limit, order: 'latest', session_id: id })
}

/** A compaction handoff row as the transcript shows it: when it was written, its summary and the messages it covers. */
export function compactionOf(row: StoredTranscriptRow): StoredCompaction | undefined {
  if (row.row_kind !== 'compaction' || typeof row.timestamp !== 'number') {
    return undefined
  }

  return {
    at: row.timestamp * 1000,
    ...(row.text ? { summary: row.text } : {}),
    ...(typeof row.compacted_messages === 'number' ? { messages: row.compacted_messages } : {})
  }
}

/** The preview's lines for one row; none for a row it does not show (system rows, empty ones). */
export function previewRows(r: StoredTranscriptRow): PreviewRow[] {
  const text = (r.text ?? '').trim()
  const key = typeof r.row_id === 'number' ? `row${r.row_id}` : `${r.role}|${r.timestamp ?? ''}|${r.tool_call_id ?? text}`

  if (r.row_kind === 'compaction') {
    const covered = typeof r.compacted_messages === 'number' ? ` (${r.compacted_messages} messages)` : ''

    return [{ key, kind: 'note', text: `Context compacted${covered}: the agent continued from a summary.`, tone: 'muted' }]
  }

  switch (r.role) {
    case 'user':
      if (r.display_kind && NOTICE_KINDS.has(r.display_kind)) {
        return [{ key, kind: 'note', text: noticeLine(text), tone: 'muted' }]
      }

      return text ? [{ key, kind: 'user', steer: r.display_kind === 'steer', text }] : []
    case 'assistant':
      if (r.display_kind === 'failed_turn') {
        return [{ key, kind: 'note', text: firstLine(text) || 'The turn failed.', tone: 'error' }]
      }

      return text ? [{ key, kind: 'assistant', text }] : []
    case 'tool':
      return [{ args: r.args ?? {}, key, kind: 'tool', name: r.name ?? 'tool' }]
    default:
      return []
  }
}

/** A notice's first line without its bracket: `[SYSTEM: Background process completed]` reads `Background process completed`. */
function noticeLine(text: string): string {
  const line = firstLine(text)

  return /^\[[A-Z][A-Z -]*:\s*(?<said>[^\]]*)\]?$/.exec(line)?.groups?.['said']?.trim() || line
}

function firstLine(text: string): string {
  return (text.split('\n').find(l => l.trim()) ?? '').trim()
}

/** The reader over the gateway: a page's rows come oldest first, and the preview shows them newest first. */
export function gatewayTranscripts(gw: Requester): TranscriptReader {
  return {
    page: async (id, cursor, limit) => {
      const r = await readTranscript(gw, id, cursor, limit)

      return { next: r.next_cursor, reset: r.reset, rows: r.rows.flatMap(previewRows).reverse() }
    }
  }
}
