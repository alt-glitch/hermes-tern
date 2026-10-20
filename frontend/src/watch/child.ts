// A subagent's stored transcript. Children are sessions of their own in the profile's
// `state.db` (source `subagent`, `parent_session_id` = the delegating session), written message
// by message while they run. The shared gateway serves neither the link nor the messages
// (`session.resume` on a child answers not_found), so this reads the database read-only.

import { DatabaseSync } from 'node:sqlite'

import type { TranscriptMessage } from '@hermes/shared/gateway-events'
import * as z from 'zod/mini'

import { stateDbPath } from '../hermes/paths.js'
import { first, real, rows, storedArgs, storedCalls, text } from '../wire/sqlite.js'

/** One `messages` row, as this reads it. A role that is not text reads as '' (a row nothing draws). */
const messageRow = z.object({
  id: z.number(),
  role: z.catch(z.string(), ''),
  content: text,
  tool_call_id: text,
  tool_calls: text,
  tool_name: text,
  timestamp: real,
  reasoning: text
})

/** One `messages` row, as this reads it. */
export type MessageRow = z.infer<typeof messageRow>

const childRow = z.object({ id: z.string() })
const lastRow = z.object({ id: real })

export class ChildStore {
  readonly #db: DatabaseSync

  constructor(path = stateDbPath()) {
    this.#db = new DatabaseSync(path, { readOnly: true })
  }

  /**
   * The child session of `parents` whose first prompt is `goal`: a child's first user turn is
   * its goal. The newest wins, as a goal can repeat across delegations; `since` (epoch ms)
   * skips older ones.
   */
  find(parents: readonly string[], goal: string, since = 0): string | undefined {
    const ids = parents.filter(Boolean)

    if (!ids.length) {
      return undefined
    }

    const stmt = this.#db.prepare(
      `SELECT s.id AS id FROM sessions s
       WHERE s.parent_session_id IN (${ids.map(() => '?').join(',')}) AND s.source = 'subagent'
         AND s.started_at >= ?
         AND (SELECT m.content FROM messages m WHERE m.session_id = s.id AND m.role = 'user'
              ORDER BY m.id LIMIT 1) = ?
       ORDER BY s.started_at DESC LIMIT 1`
    )

    return first(stmt, childRow, ...ids, Math.max(0, since / 1000 - 5), goal)?.id
  }

  /** The child's active messages as the gateway's transcript messages, oldest first. */
  messages(session: string): TranscriptMessage[] {
    const stmt = this.#db.prepare(
      `SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp, reasoning
       FROM messages WHERE session_id = ? AND active = 1 ORDER BY id`
    )

    return toTranscript(rows(stmt, messageRow, session))
  }

  /** The newest message id of `session`, to tell whether anything changed. */
  last(session: string): number {
    return first(this.#db.prepare('SELECT MAX(id) AS id FROM messages WHERE session_id = ?'), lastRow, session)?.id ?? 0
  }

  close() {
    this.#db.close()
  }
}

/**
 * Rows to the shape `Transcript.load` reads: each call an assistant row made becomes a tool
 * message carrying its name and arguments, and the matching `tool` row fills in its result.
 */
export function toTranscript(rows: readonly MessageRow[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = []

  for (const r of rows) {
    const timestamp = r.timestamp

    if (r.role === 'user' || r.role === 'system') {
      out.push({ content: r.content ?? '', role: r.role, timestamp })

      continue
    }

    if (r.role === 'assistant') {
      out.push({ content: r.content ?? '', reasoning: r.reasoning, role: 'assistant', timestamp })

      for (const call of storedCalls(r.tool_calls)) {
        out.push({
          args: storedArgs(call.function?.arguments),
          name: call.function?.name ?? 'tool',
          role: 'tool',
          timestamp,
          tool_call_id: call.id ?? call.call_id ?? null
        })
      }

      continue
    }

    if (r.role === 'tool') {
      out.push({
        content: r.content ?? '',
        name: r.tool_name,
        role: 'tool',
        timestamp,
        tool_call_id: r.tool_call_id
      })
    }
  }

  return out
}
