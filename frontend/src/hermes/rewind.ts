// `/undo` and `/retry` targets on the shared gateway: the `session.mutate` rewind payload names
// the newest human user turn of the snapshot its CAS tuple came from. Ported from Hermes'
// ui-tui/src/app/slash/canonicalSessionCommands.ts (lastTurnRewind, retryTurnRewind, retryText).
import type { Snapshot } from './mutate.js'

const COMPACTION_MARKERS = ['[CONTEXT COMPACTION', '[CONTEXT SUMMARY]:', '[END OF PRIOR CONTEXT']

/** A human-authored user turn: no display-only kind but a typed /steer, and no compaction handoff. */
const isUserTurn = (row: Record<string, unknown>) =>
  row.role === 'user' &&
  (!row.display_kind || row.display_kind === 'steer') &&
  Number.isSafeInteger(row.row_id) &&
  !(typeof row.content === 'string' && COMPACTION_MARKERS.some(marker => (row.content as string).includes(marker)))

const lastUserTurn = (snapshot: Snapshot) => (snapshot.stored_messages ?? snapshot.messages ?? []).findLast(isUserTurn)

/** The rewind payload for the newest user turn; null when there is none. */
export function lastTurnRewind(snapshot: Snapshot): { target_message_id: number } | null {
  const target = lastUserTurn(snapshot)

  return target ? { target_message_id: target.row_id as number } : null
}

const TEXT_PARTS = new Set(['input_text', 'output_text', 'text'])

/** A turn's text to resend: '' when it has none, null when it carries media or unknown parts (no replay for those). */
export function retryText(content: unknown): string | null {
  let text = ''

  for (const part of typeof content === 'string' ? [content] : Array.isArray(content) ? content : [null]) {
    if (typeof part === 'string') {
      text += part
    } else if (part?.type && TEXT_PARTS.has(part.type) && typeof part.text === 'string' && Object.keys(part).length === 2) {
      text += part.text
    } else {
      return null
    }
  }

  return text.trim() ? text : ''
}

/** /retry's rewind payload, checked on the snapshot so a turn it cannot resend is never rewound. */
export function retryTurnRewind(snapshot: Snapshot): { target_message_id: number } | null {
  const target = lastUserTurn(snapshot)
  const text = target ? retryText(target.content) : ''

  if (text === null) {
    throw new Error('/retry: retry does not support media or unknown content parts')
  }

  return target && text ? { target_message_id: target.row_id as number } : null
}
