// The stored sessions for the session picker, read from the profile's `state.db` (read-only),
// because the shared gateway's `session.list` serves only the sessions it holds live (and legacy
// rows to a native transport), with no folder, prompt or activity. The rules follow Hermes'
// own listing (hermes_state_sessions.list_sessions_rich): human sources only, archived and hidden
// rows out unless pinned, subagent runs and compression continuations folded into their root, a
// chain shown with its tip's activity and size. The folder rule is the CLI's `hermes -c` one
// (hermes_state_sessions.workspace_key): the same repo root, or the folder or one under it.

import { execFile } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'

import { stateDbPath } from '../watch/child.js'

const run = promisify(execFile)

/** One stored conversation as the picker shows it. */
export interface StoredSession {
  /** The chain's root id: what `session.resume` takes. */
  id: string
  title: string
  /** The first prompt, flattened. */
  preview: string
  source: string
  cwd: string
  repoRoot: string
  branch: string
  model: string
  /** Epoch ms. */
  startedAt: number
  lastActive: number
  messages: number
  pinned: boolean
}

/** Local surfaces a pane can resume (gateway platforms and cron runs stay out). */
const SOURCES = ['acp', 'cli', 'desktop', 'gui', 'local', 'tui']

const LISTABLE = `(s.parent_session_id IS NULL
  OR json_extract(s.model_config, '$._branched_from') IS NOT NULL
  OR json_extract(s.model_config, '$._reset_from') IS NOT NULL)`

/** Roots and their compression continuations, newest activity first, `limit` chains. */
const QUERY = `
WITH RECURSIVE chain(root, cur) AS (
  SELECT s.id, s.id FROM sessions s
  WHERE s.source IN (${SOURCES.map(() => '?').join(',')})
    AND ${LISTABLE}
    AND (s.pinned = 1 OR (COALESCE(s.archived, 0) = 0 AND COALESCE(s.hidden, 0) = 0))
  UNION ALL
  SELECT c.root, child.id FROM chain c
  JOIN sessions parent ON parent.id = c.cur
  JOIN sessions child ON child.parent_session_id = c.cur
  WHERE parent.end_reason = 'compression'
    AND json_extract(child.model_config, '$._branched_from') IS NULL
    AND json_extract(child.model_config, '$._delegate_from') IS NULL
    AND json_extract(child.model_config, '$._reset_from') IS NULL
),
spans AS (
  SELECT c.root,
    MAX(COALESCE(t.last_activity_at, t.ended_at, t.started_at)) AS last_active,
    (SELECT c2.cur FROM chain c2 JOIN sessions t2 ON t2.id = c2.cur WHERE c2.root = c.root ORDER BY t2.started_at DESC LIMIT 1) AS tip
  FROM chain c JOIN sessions t ON t.id = c.cur
  GROUP BY c.root
)
SELECT r.id, COALESCE(NULLIF(r.display_name, ''), r.title, '') AS title, r.source, COALESCE(tip.cwd, r.cwd, '') AS cwd,
  COALESCE(NULLIF(tip.git_repo_root, ''), r.git_repo_root, '') AS repo_root,
  COALESCE(NULLIF(tip.git_branch, ''), r.git_branch, '') AS branch, COALESCE(tip.model, r.model, '') AS model,
  r.started_at, sp.last_active, COALESCE(tip.message_count, r.message_count, 0) AS messages, COALESCE(r.pinned, 0) AS pinned,
  (SELECT m.content FROM messages m WHERE m.session_id = r.id AND m.role = 'user' ORDER BY m.id LIMIT 1) AS preview
FROM spans sp JOIN sessions r ON r.id = sp.root LEFT JOIN sessions tip ON tip.id = sp.tip
ORDER BY sp.last_active DESC
LIMIT ?`

interface Row {
  id: string
  title: string | null
  source: string | null
  cwd: string
  repo_root: string
  branch: string
  model: string
  started_at: number | null
  last_active: number | null
  messages: number
  pinned: number
  preview: string | null
}

/** Hermes wraps steers and notices in markers; the picker wants the words. */
function flat(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/^\[[A-Z][A-Z -]+\][^\n]*\n?/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The newest `limit` stored conversations, newest activity first; empty when there is no database. */
export function storedSessions(limit = 400, db = stateDbPath()): StoredSession[] {
  let conn: DatabaseSync | undefined

  try {
    conn = new DatabaseSync(db, { readOnly: true })
    const rows = conn.prepare(QUERY).all(...SOURCES, limit) as unknown as Row[]

    return rows.map(r => ({
      branch: r.branch ?? '',
      cwd: r.cwd ?? '',
      id: r.id,
      lastActive: Math.round((r.last_active ?? r.started_at ?? 0) * 1000),
      messages: Number(r.messages) || 0,
      model: r.model ?? '',
      pinned: r.pinned === 1,
      preview: flat(r.preview).slice(0, 400),
      repoRoot: r.repo_root ?? '',
      source: r.source ?? '',
      startedAt: Math.round((r.started_at ?? 0) * 1000),
      title: (r.title ?? '').trim()
    }))
  } catch {
    return []
  } finally {
    conn?.close()
  }
}

/** A conversation's last reply (from its newest segment), for the picker's preview. */
export function lastReply(id: string, db = stateDbPath()): string {
  let conn: DatabaseSync | undefined

  try {
    conn = new DatabaseSync(db, { readOnly: true })
    const row = conn
      .prepare(
        `WITH RECURSIVE chain(cur) AS (SELECT ? UNION ALL SELECT child.id FROM chain c
           JOIN sessions parent ON parent.id = c.cur JOIN sessions child ON child.parent_session_id = c.cur
           WHERE parent.end_reason = 'compression')
         SELECT m.content FROM messages m WHERE m.session_id IN (SELECT cur FROM chain)
           AND m.role = 'assistant' AND m.content IS NOT NULL AND m.content != ''
         ORDER BY m.timestamp DESC, m.id DESC LIMIT 1`
      )
      .get(id) as { content?: string } | undefined

    return (row?.content ?? '').trim()
  } catch {
    return ''
  } finally {
    conn?.close()
  }
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

/** `s` belongs to workspace `key`: the same repo root, or (no root recorded) its folder is `key` or under it. */
export function inWorkspace(s: Pick<StoredSession, 'cwd' | 'repoRoot'>, key: string): boolean {
  const k = trim(key)

  if (!k) {
    return false
  }

  if (s.repoRoot) {
    return trim(s.repoRoot) === k
  }

  const cwd = trim(s.cwd)

  return cwd === k || cwd.startsWith(`${k}/`)
}

/** What the picker shows as a session's name: its title, else its first prompt, else untitled. */
export function sessionLabel(s: Pick<StoredSession, 'preview' | 'title'>): string {
  return s.title || s.preview.split(/(?<=[.?!])\s/)[0]?.slice(0, 110) || 'Untitled session'
}
