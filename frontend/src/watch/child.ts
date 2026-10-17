// A subagent's stored transcript. Children are sessions of their own in the profile's
// `state.db` (source `subagent`, `parent_session_id` = the delegating session), written message
// by message while they run. The shared gateway serves neither the link nor the messages
// (`session.resume` on a child answers not_found), so this reads the database read-only.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { TranscriptMessage } from '@hermes/shared/gateway-events'

/** One `messages` row, as this reads it. */
interface Row {
  id: number
  role: string
  content: string | null
  tool_call_id: string | null
  tool_calls: string | null
  tool_name: string | null
  timestamp: number
  reasoning: string | null
}

export function stateDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HERMES_HOME || join(homedir(), '.hermes'), 'state.db')
}

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

    const row = this.#db
      .prepare(
        `SELECT s.id AS id FROM sessions s
         WHERE s.parent_session_id IN (${ids.map(() => '?').join(',')}) AND s.source = 'subagent'
           AND s.started_at >= ?
           AND (SELECT m.content FROM messages m WHERE m.session_id = s.id AND m.role = 'user'
                ORDER BY m.id LIMIT 1) = ?
         ORDER BY s.started_at DESC LIMIT 1`
      )
      .get(...ids, Math.max(0, since / 1000 - 5), goal) as { id?: string } | undefined

    return row?.id
  }

  /** The child's active messages as the gateway's transcript messages, oldest first. */
  messages(session: string): TranscriptMessage[] {
    const rows = this.#db
      .prepare(
        `SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp, reasoning
         FROM messages WHERE session_id = ? AND active = 1 ORDER BY id`
      )
      .all(session) as unknown as Row[]

    return toTranscript(rows)
  }

  /** The newest message id of `session`, to tell whether anything changed. */
  last(session: string): number {
    const row = this.#db.prepare('SELECT MAX(id) AS id FROM messages WHERE session_id = ?').get(session) as
      | { id?: number | null }
      | undefined

    return row?.id ?? 0
  }

  close() {
    this.#db.close()
  }
}

interface StoredCall {
  id?: string
  call_id?: string
  function?: { name?: string; arguments?: string }
}

/**
 * Rows to the shape `Transcript.load` reads: each call an assistant row made becomes a tool
 * message carrying its name and arguments, and the matching `tool` row fills in its result.
 */
export function toTranscript(rows: readonly Row[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = []

  for (const r of rows) {
    const timestamp = r.timestamp

    if (r.role === 'user' || r.role === 'system') {
      out.push({ content: r.content ?? '', role: r.role, timestamp } as TranscriptMessage)

      continue
    }

    if (r.role === 'assistant') {
      out.push({ content: r.content ?? '', reasoning: r.reasoning ?? undefined, role: 'assistant', timestamp } as TranscriptMessage)

      for (const call of parseCalls(r.tool_calls)) {
        out.push({
          args: parseArgs(call.function?.arguments),
          name: call.function?.name ?? 'tool',
          role: 'tool',
          timestamp,
          tool_call_id: call.id ?? call.call_id
        } as TranscriptMessage)
      }

      continue
    }

    if (r.role === 'tool') {
      out.push({
        content: r.content ?? '',
        name: r.tool_name ?? undefined,
        role: 'tool',
        timestamp,
        tool_call_id: r.tool_call_id ?? undefined
      } as TranscriptMessage)
    }
  }

  return out
}

function parseCalls(raw: string | null): StoredCall[] {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : []

    return Array.isArray(parsed) ? (parsed as StoredCall[]) : []
  } catch {
    return []
  }
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {}

    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
