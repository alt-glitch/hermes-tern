// The conversations the session picker offers, from the gateway's `session.list` with its picker
// fields (gateway/session_picker_fields.py). The gateway lists them in two scopes, as Ink's session
// switcher reads them: `live` holds the sessions its authority serves (open in a pane, or running),
// `stored` the ones it can resume from history (closed by their last viewer, older local rows, and
// messaging conversations). The live scope is one short list. The stored scope is read a page at
// a time: each page holds at most 200 rows and names the cursor of the next one.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import * as z from 'zod/mini'

import { optional } from '../core/assert.js'
import { type Requester, rpcParsed } from '../wire/rpc.js'
import { loose, rowsOf } from '../wire/schemas.js'

const run = promisify(execFile)

/** The most rows one `session.list` call returns: the gateway's cap. */
const LIMIT = 200

/** One conversation as the picker shows it. */
export interface ListedSession {
  /** What `session.resume` takes: the gateway's `session_id`. */
  id: string
  /** The conversation's id when it differs (a messaging lineage's root, a closed session's owner). */
  conversation: string
  title: string
  /** The first prompt, shortened by the gateway. */
  preview: string
  /** The newest reply, shortened by the gateway. */
  lastReply: string
  source: string
  cwd: string
  /** The folder sessions group under: the git repo root of the first segment, else its folder. */
  workspace: string
  branch: string
  model: string
  /** Epoch ms. */
  startedAt: number
  lastActive: number
  messages: number
  pinned: boolean
  running: boolean
}

const listRow = z.object({
  session_id: z.string(),
  id: z.string(),
  title: loose(z.nullable(z.string())),
  source: loose(z.nullable(z.string())),
  started_at: loose(z.nullable(z.number())),
  message_count: loose(z.nullable(z.number())),
  running: loose(z.nullable(z.boolean())),
  model: loose(z.nullable(z.string())),
  preview: loose(z.nullable(z.string())),
  last_reply: loose(z.nullable(z.string())),
  cwd: loose(z.nullable(z.string())),
  git_branch: loose(z.nullable(z.string())),
  workspace: loose(z.nullable(z.string())),
  last_active_at: loose(z.nullable(z.number())),
  pinned: loose(z.nullable(z.boolean()))
})

const listResult = z.object({
  next_cursor: loose(z.nullable(z.string())),
  sessions: z.catch(z.array(z.unknown()), [])
})

/** What narrows a listing: a folder (the gateway's `hermes -c` rule), and text in a title or id (stored scope only). */
export interface SessionFilter {
  workspace?: string | undefined
  query?: string | undefined
}

/** One page of the stored scope, and the cursor of the next page (null when there is none). */
export interface StoredPage {
  rows: ListedSession[]
  next: string | null
}

function listed(r: z.infer<typeof listRow>): ListedSession {
  const startedAt = Math.round((r.started_at ?? 0) * 1000)

  return {
    branch: r.git_branch ?? '',
    conversation: r.id,
    cwd: r.cwd ?? '',
    id: r.session_id,
    lastActive: r.last_active_at ? Math.round(r.last_active_at * 1000) : startedAt,
    lastReply: r.last_reply ?? '',
    messages: r.message_count ?? 0,
    model: r.model ?? '',
    pinned: r.pinned === true,
    preview: r.preview ?? '',
    running: r.running === true,
    source: r.source ?? '',
    startedAt,
    title: (r.title ?? '').trim(),
    workspace: r.workspace ?? ''
  }
}

/** The sessions the gateway serves now, in `workspace` when one is named. */
export async function liveSessions(gw: Requester, workspace?: string): Promise<ListedSession[]> {
  const r = await rpcParsed(gw, 'session.list', { limit: LIMIT, picker: true, scope: 'live', ...optional('workspace', workspace) }, listResult)

  return rowsOf(listRow, r.sessions).map(listed)
}

/** The stored page after `cursor` (the first page with none), narrowed by `filter`. */
export async function storedPage(gw: Requester, filter: SessionFilter, cursor?: string): Promise<StoredPage> {
  const params = {
    limit: LIMIT,
    picker: true,
    scope: 'stored' as const,
    ...optional('workspace', filter.workspace),
    ...optional('query', filter.query),
    ...optional('cursor', cursor)
  }
  const r = await rpcParsed(gw, 'session.list', params, listResult)

  return { next: r.next_cursor ?? null, rows: rowsOf(listRow, r.sessions).map(listed) }
}

/** The folder sessions group under: the git repo holding `cwd`, else `cwd` itself (the CLI's workspace key). */
export async function workspaceOf(cwd: string): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 3000 })

    return stdout.trim() || cwd
  } catch {
    return cwd
  }
}

const trim = (p: string) => p.replace(/\/+$/, '')

/** `s` belongs to workspace `key`: its workspace is `key`, or a folder under it (a session that ran outside any repo). */
export function inWorkspace(s: Pick<ListedSession, 'workspace'>, key: string): boolean {
  const k = trim(key)
  const w = trim(s.workspace)

  return Boolean(k) && (w === k || w.startsWith(`${k}/`))
}

/** What the picker shows as a session's name: its title, else its first prompt, else untitled. */
export function sessionLabel(s: Pick<ListedSession, 'preview' | 'title'>): string {
  return s.title || s.preview.split(/(?<=[.?!])\s/)[0]?.slice(0, 110) || 'Untitled session'
}
