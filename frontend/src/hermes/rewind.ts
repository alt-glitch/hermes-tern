// Rewind and branch targets on the shared gateway: a `session.mutate` rewind payload names a human
// user turn of the snapshot its CAS tuple came from (`/undo [N]` and `/retry` the newest ones, the
// /rewind sheet any of them), and a branch's `through_message_id` the stored row before one. Ported
// from Hermes' ui-tui/src/app/slash/canonicalSessionCommands.ts (lastTurnRewind, retryTurnRewind,
// retryText); `/undo N` counts as the CLI's undo_last does.
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

/** The stored rows win over a display projection. */
const rowsOf = (snapshot: Rows): readonly TranscriptMessage[] => snapshot.stored_messages ?? snapshot.messages ?? []

/** The snapshot's human user turns, oldest first: the prompts a rewind or a branch can name. */
export const userTurns = (snapshot: Rows): UserTurn[] => rowsOf(snapshot).filter(isUserTurn)

/** The user turn stored as row `rowId` in this snapshot, if it still is one. */
export const userTurn = (snapshot: Rows, rowId: number): UserTurn | undefined => userTurns(snapshot).find(t => t.row_id === rowId)

/**
 * `/undo N`'s payload: rewind to before the `n`th newest user turn, clamped to the oldest one, as
 * the CLI's undo_last counts. Null when there is no user turn.
 */
export const undoRewind =
  (n: number) =>
  (snapshot: Rows): { target_message_id: number } | null => {
    const turns = userTurns(snapshot)
    const target = turns.at(-Math.min(Math.max(1, n), turns.length))

    return target ? { target_message_id: target.row_id } : null
  }

/** The rewind payload for the newest user turn; null when there is none. */
export const lastTurnRewind = undoRewind(1)

/**
 * The newest stored row before row `rowId`: where a branch that leaves that turn and what follows
 * out ends (the branch payload's `through_message_id`). Null when the turn opens the session, so a
 * branch would copy nothing.
 */
export function rowBefore(snapshot: Rows, rowId: number): number | null {
  const earlier = rowsOf(snapshot)
    .map(row => row.row_id)
    .filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id < rowId)

  return earlier.length ? Math.max(...earlier) : null
}

/** A text part as a content list carries it: its type and its text, and nothing else. */
const textPart = z.strictObject({ type: z.enum(['input_text', 'output_text', 'text']), text: z.string() })

/**
 * A prompt's text parts, joined ('' when it has none), and whether it carried anything else (an
 * image, a file, a shape this does not know): those do not come back as text.
 */
export function promptText(content: unknown): { text: string; media: boolean } {
  const parts: readonly unknown[] = typeof content === 'string' ? [content] : Array.isArray(content) ? content : [null]
  let text = ''
  let media = false

  for (const part of parts) {
    const textOf = typeof part === 'string' ? part : textPart.safeParse(part).data?.text

    if (textOf === undefined) {
      media = true
    } else {
      text += textOf
    }
  }

  return { media, text: text.trim() ? text : '' }
}

/** One prompt as the rewind sheet lists it. */
export interface PromptRow {
  /** The stored row: the rewind's target. */
  row: number
  text: string
  /** It carried parts that are not text (an image). */
  media: boolean
  /** A typed /steer, not a prompt of its own. */
  steer: boolean
  /** The last text Hermes answered it with, before the next prompt; '' for none. */
  reply: string
  /** How many prompts follow it: what a rewind to it removes besides it. */
  after: number
}

/** The snapshot's prompts, oldest first, each with its reply and the count of prompts after it. */
export function promptRows(snapshot: Rows): PromptRow[] {
  const out: PromptRow[] = []

  for (const row of rowsOf(snapshot)) {
    if (isUserTurn(row)) {
      out.push({ after: 0, reply: '', row: row.row_id, steer: row.display_kind === 'steer', ...promptText(row.content) })
    } else if (row.role === 'assistant' && !row.display_kind) {
      const last = out.at(-1)
      const said = promptText(row.content).text

      if (last && said) {
        last.reply = said
      }
    }
  }

  return out.map((p, i) => ({ ...p, after: out.length - 1 - i }))
}

/** A turn's text to resend: '' when it has none, null when it carries media or unknown parts (no replay for those). */
export function retryText(content: unknown): string | null {
  const { media, text } = promptText(content)

  return media ? null : text
}

/** /retry's rewind payload, checked on the snapshot so a turn it cannot resend is never rewound. */
export function retryTurnRewind(snapshot: Rows): { target_message_id: number } | null {
  const target = userTurns(snapshot).at(-1)
  const text = target ? retryText(target.content) : ''

  if (text === null) {
    throw new Error('/retry: retry does not support media or unknown content parts')
  }

  return target && text ? { target_message_id: target.row_id } : null
}
