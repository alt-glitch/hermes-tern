// `/undo` and `/retry` targets on the shared gateway: the `session.mutate` rewind payload names
// the newest human user turn of the snapshot its CAS tuple came from. Ported from Hermes'
// ui-tui/src/app/slash/canonicalSessionCommands.ts (lastTurnRewind, retryTurnRewind, retryText).
import type { TranscriptMessage } from '@hermes/shared/gateway-events'
import * as z from 'zod/mini'

import type { AdaptedSnapshot } from '../wire/rpc.js'

/** The snapshot rows a rewind target is read from. */
type Rows = Partial<Pick<AdaptedSnapshot, 'messages' | 'stored_messages'>>

/** A row a rewind can name: the store's id is a safe integer. */
type UserTurn = TranscriptMessage & { row_id: number }

const COMPACTION_MARKERS = ['[CONTEXT COMPACTION', '[CONTEXT SUMMARY]:', '[END OF PRIOR CONTEXT']

/** A human-authored user turn: no display-only kind but a typed /steer, a store id, and no compaction handoff. */
function isUserTurn(row: TranscriptMessage): row is UserTurn {
  const { content } = row

  return (
    row.role === 'user' &&
    (!row.display_kind || row.display_kind === 'steer') &&
    Number.isSafeInteger(row.row_id) &&
    !(typeof content === 'string' && COMPACTION_MARKERS.some(marker => content.includes(marker)))
  )
}

const lastUserTurn = (snapshot: Rows): UserTurn | undefined => (snapshot.stored_messages ?? snapshot.messages ?? []).findLast(isUserTurn)

/** The rewind payload for the newest user turn; null when there is none. */
export function lastTurnRewind(snapshot: Rows): { target_message_id: number } | null {
  const target = lastUserTurn(snapshot)

  return target ? { target_message_id: target.row_id } : null
}

/** A text part as a content list carries it: its type and its text, and nothing else. */
const textPart = z.strictObject({ type: z.enum(['input_text', 'output_text', 'text']), text: z.string() })

/** A turn's text to resend: '' when it has none, null when it carries media or unknown parts (no replay for those). */
export function retryText(content: unknown): string | null {
  const parts: readonly unknown[] = typeof content === 'string' ? [content] : Array.isArray(content) ? content : [null]
  let text = ''

  for (const part of parts) {
    const textOf = typeof part === 'string' ? part : textPart.safeParse(part).data?.text

    if (textOf === undefined) {
      return null
    }

    text += textOf
  }

  return text.trim() ? text : ''
}

/** /retry's rewind payload, checked on the snapshot so a turn it cannot resend is never rewound. */
export function retryTurnRewind(snapshot: Rows): { target_message_id: number } | null {
  const target = lastUserTurn(snapshot)
  const text = target ? retryText(target.content) : ''

  if (text === null) {
    throw new Error('/retry: retry does not support media or unknown content parts')
  }

  return target && text ? { target_message_id: target.row_id } : null
}
