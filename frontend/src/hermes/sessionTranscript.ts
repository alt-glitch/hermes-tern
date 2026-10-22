// A stored conversation as the session picker previews it, read from the profile's `state.db`
// (read-only). The gateway has no read for a session nobody holds: classic `session.history` and
// the shared gateway's `session.events.since` serve an attached session only, and a
// `session.resume` would attach this pane to it. So, like the listing (sessionIndex.ts) and a
// subagent's transcript (watch/child.ts), this reads the rows Hermes wrote: the conversation's
// root and its compression continuations, the rows a display read shows (live, or archived by an
// in-place compaction), in insertion order. A page is keyed by the last row id it read, so the
// next one starts after it; rows a compaction copied into a later segment are left out by key.

import { DatabaseSync } from 'node:sqlite'

import * as z from 'zod/mini'

import { parseJson } from '../wire/json.js'
import { first, real, rows, type StoredCall, storedArgs, storedCalls, text, textBytes } from '../wire/sqlite.js'

import { stateDbPath } from './paths.js'

/** One line of the preview's transcript. */
export type PreviewRow =
  | { kind: 'user'; key: string; text: string; steer: boolean }
  | { kind: 'assistant'; key: string; text: string }
  | { kind: 'tool'; key: string; name: string; args: Record<string, unknown> }
  | { kind: 'note'; key: string; text: string; tone: 'error' | 'muted' }

/** One page: its rows, and the cursor of the next page (null at the end). */
export interface TranscriptPage {
  rows: PreviewRow[]
  next: number | null
}

/** The whole first prompt and last reply, for the preview's two fixed sections. */
export interface SessionEnds {
  firstPrompt: string
  lastReply: string
}

/** What the preview reads; the picker's loader takes it so the tests can stand in for the database. */
export interface TranscriptReader {
  ends(id: string): Promise<SessionEnds>
  page(id: string, after: number, limit: number): Promise<TranscriptPage>
}

/** Where Hermes' compaction handoff starts (agent/context_compressor.py). */
const COMPACTION = '[CONTEXT COMPACTION'
/** Structured content (a list of parts) is stored as this prefix and JSON (hermes_state `_encode_content`). */
const JSON_CONTENT = '\x00json:'
/** User rows Hermes writes for the agent, not typed by the user: one line each in the preview. */
const NOTICE_KINDS = new Set(['async_delegation_complete', 'internal_notification', 'model_switch', 'process_complete'])

/** The conversation's segments: `?` and its compression continuations (branches, delegations and resets are their own). */
const CHAIN = `WITH RECURSIVE chain(cur) AS (
  SELECT ? UNION ALL
  SELECT child.id FROM chain c
  JOIN sessions parent ON parent.id = c.cur
  JOIN sessions child ON child.parent_session_id = c.cur
  WHERE parent.end_reason = 'compression'
    AND ${['_branched_from', '_delegate_from', '_reset_from']
      .map(k => `json_extract(CASE WHEN json_valid(child.model_config) THEN child.model_config ELSE '{}' END, '$.${k}') IS NULL`)
      .join(' AND ')}
)`

const nameRow = z.object({ name: z.string() })

const messageRow = z.object({
  id: z.number(),
  role: z.catch(z.string(), ''),
  content: textBytes,
  tool_calls: text,
  timestamp: real,
  display_kind: text
})

type MessageRow = z.infer<typeof messageRow>

const contentRow = z.object({ content: textBytes })

/** The columns an older database may not have, each read as NULL there. */
function messageColumns(conn: DatabaseSync): { calls: string; kind: string; visible: string } {
  const has = new Set(rows(conn.prepare('PRAGMA table_info(messages)'), nameRow).map(r => r.name))
  const live = has.has('compacted') ? '(m.active = 1 OR m.compacted = 1)' : has.has('active') ? 'm.active = 1' : '1'
  const modelOnly = has.has('display_metadata')
    ? ` AND COALESCE(json_extract(CASE WHEN json_valid(m.display_metadata) THEN m.display_metadata ELSE '{}' END, '$.model_only'), 0) = 0`
    : ''

  const kind = has.has('display_kind') ? 'm.display_kind' : 'NULL'

  return {
    calls: has.has('tool_calls') ? 'm.tool_calls' : 'NULL',
    kind,
    visible: `${live}${modelOnly} AND COALESCE(${kind}, '') != 'hidden'`
  }
}

function readStateDb<T>(db: string, read: (conn: DatabaseSync) => T): T {
  const conn = new DatabaseSync(db, { readOnly: true })

  try {
    return read(conn)
  } finally {
    conn.close()
  }
}

/** A stored row's text: plain text, or the text parts of structured content. */
export function contentText(raw: string | null): string {
  if (!raw) {
    return ''
  }

  const json = raw.startsWith(JSON_CONTENT) ? raw.slice(JSON_CONTENT.length) : raw.startsWith('[{') ? raw : undefined

  if (json === undefined) {
    return raw
  }

  const parts = parseJson(json)

  if (typeof parts === 'string') {
    return parts
  }

  return Array.isArray(parts)
    ? parts
        .map((p: unknown) => (p && typeof p === 'object' && 'text' in p && typeof p.text === 'string' ? p.text : ''))
        .filter(Boolean)
        .join('\n')
    : raw
}

/** Hermes' `/skill` scaffold (agent/skill_commands.py): the skill's body wrapped around what the user typed. */
const SKILL_PREFIX = '[IMPORTANT: The user has invoked the '
const SKILL_INSTRUCTION = 'The user has provided the following instruction alongside the skill invocation: '
const BUNDLE_INSTRUCTION = '\nUser instruction: '

/**
 * A `/skill` turn as the user typed it (`/name instruction`, `describe_skill_invocation`): the
 * stored row holds the whole skill body. Any other text comes back as it is.
 */
export function skillPrompt(raw: string): string {
  if (!raw.startsWith(SKILL_PREFIX)) {
    return raw
  }

  const name = /^"(?<name>[^"]*)"/.exec(raw.slice(SKILL_PREFIX.length))?.groups?.['name']?.trim() ?? ''
  const label = name.startsWith('/') ? name : `/${name}`
  const bundle = raw.includes(' skill bundle,')
  const marker = bundle ? BUNDLE_INSTRUCTION : SKILL_INSTRUCTION
  // A bundle's instruction comes before its skills; a single skill's follows the body (which may quote the marker).
  const at = bundle ? raw.indexOf(marker) : raw.lastIndexOf(marker)

  if (at < 0) {
    return label
  }

  const rest = raw.slice(at + marker.length)
  const end = rest.indexOf(bundle ? '\n\n[Loaded as part of the ' : '\n\n[Runtime note:')
  const instruction = (end < 0 ? rest : rest.slice(0, end)).trim()

  return instruction ? `${label} ${instruction}` : label
}

/** A prompt as the user typed it: a `/skill` turn as its invocation, no Hermes marker lines, an attached image as `[image]`. */
export function promptText(raw: string): string {
  return skillPrompt(raw)
    .replace(/^\[[A-Z][A-Z -]+\][^\n]*\n?/gm, '')
    .replace(/^@image:\S+\s*$/gm, '')
    .replace(/^\[Image attached at: [^\]\n]*\]\s*$/gm, '[image]')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The preview's lines for one stored row; none for a row it does not show (a tool's result, system rows). */
export function previewRows(r: MessageRow): PreviewRow[] {
  const body = contentText(r.content)
  const key = `${r.role}|${r.timestamp ?? ''}|${body}`

  if (r.role === 'user') {
    if (body.includes(COMPACTION)) {
      return [{ key, kind: 'note', text: 'Context compacted: the agent continued from a summary.', tone: 'muted' }]
    }

    if (r.display_kind && NOTICE_KINDS.has(r.display_kind)) {
      return [{ key, kind: 'note', text: noticeLine(body), tone: 'muted' }]
    }

    const typed = promptText(body)

    return typed ? [{ key, kind: 'user', steer: r.display_kind === 'steer', text: typed }] : []
  }

  if (r.role !== 'assistant') {
    return []
  }

  if (r.display_kind === 'failed_turn') {
    return [{ key, kind: 'note', text: firstLine(body) || 'The turn failed.', tone: 'error' }]
  }

  const out: PreviewRow[] = body.trim() ? [{ key, kind: 'assistant', text: body.trim() }] : []

  callsOf(r.tool_calls).forEach((call, i) => {
    out.push({
      args: storedArgs(call.function?.arguments),
      key: `${key}|call${i}|${call.id ?? call.call_id ?? ''}`,
      kind: 'tool',
      name: call.function?.name ?? 'tool'
    })
  })

  return out
}

/** A row's calls; none when its list holds a null (storedCalls throws there), so one bad row costs its calls, not the page. */
function callsOf(raw: string | null): StoredCall[] {
  try {
    return storedCalls(raw)
  } catch {
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

/** Up to `limit` stored rows of conversation `id` after row id `after`, as preview lines. */
export function readTranscriptPage(id: string, after: number, limit: number, db = stateDbPath()): TranscriptPage {
  return readStateDb(db, conn => {
    const { calls, kind, visible } = messageColumns(conn)
    const stmt = conn.prepare(
      `${CHAIN}
       SELECT m.id, m.role, CAST(m.content AS BLOB) AS content, ${calls} AS tool_calls, m.timestamp, ${kind} AS display_kind
       FROM messages m WHERE m.session_id IN (SELECT cur FROM chain) AND m.id > ? AND ${visible}
       ORDER BY m.id LIMIT ?`
    )
    const read = rows(stmt, messageRow, id, after, limit)
    const last = read.at(-1)

    return { next: read.length >= limit && last ? last.id : null, rows: read.flatMap(previewRows) }
  })
}

/** Conversation `id`'s first typed prompt and its last reply, whole. */
export function readSessionEnds(id: string, db = stateDbPath()): SessionEnds {
  return readStateDb(db, conn => {
    const { kind, visible } = messageColumns(conn)
    const firstPrompt = conn.prepare(
      `${CHAIN}
       SELECT CAST(m.content AS BLOB) AS content FROM messages m WHERE m.session_id IN (SELECT cur FROM chain) AND m.role = 'user' AND ${visible}
         AND COALESCE(${kind}, '') IN ('', 'steer') AND instr(COALESCE(m.content, ''), '${COMPACTION}') = 0
       ORDER BY m.id LIMIT 1`
    )
    const lastReply = conn.prepare(
      `${CHAIN}
       SELECT CAST(m.content AS BLOB) AS content FROM messages m WHERE m.session_id IN (SELECT cur FROM chain) AND m.role = 'assistant' AND ${visible}
         AND COALESCE(${kind}, '') != 'failed_turn' AND m.content IS NOT NULL AND m.content != ''
       ORDER BY m.id DESC LIMIT 1`
    )

    return {
      firstPrompt: promptText(contentText(first(firstPrompt, contentRow, id)?.content ?? null)),
      lastReply: contentText(first(lastReply, contentRow, id)?.content ?? null).trim()
    }
  })
}

/** The reader over the profile's state.db. Reads are synchronous; each runs after the caller's turn. */
export function storedTranscripts(db = stateDbPath()): TranscriptReader {
  const later = <T>(read: () => T) => new Promise<T>((resolve, reject) => setImmediate(() => {
    try {
      resolve(read())
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  }))

  return {
    ends: id => later(() => readSessionEnds(id, db)),
    page: (id, after, limit) => later(() => readTranscriptPage(id, after, limit, db))
  }
}
