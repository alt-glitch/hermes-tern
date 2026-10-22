import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import { inWorkspace, sessionLabel, storedSessions, supersededSegments } from '../hermes/sessionIndex.js'

function db(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'tern-sessions-')), 'state.db')
  const conn = new DatabaseSync(path)
  conn.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, parent_session_id TEXT, model_config TEXT,
    archived INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0, end_reason TEXT,
    last_activity_at REAL, ended_at REAL, started_at REAL, display_name TEXT, title TEXT, cwd TEXT,
    git_repo_root TEXT, git_branch TEXT, model TEXT, message_count INTEGER);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL);`)
  const add = conn.prepare(`INSERT INTO sessions (id, source, parent_session_id, model_config, archived, pinned, end_reason,
    last_activity_at, started_at, title, cwd, git_repo_root, git_branch, model, message_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  // A compressed conversation: root (old) and its continuation (recent, bigger).
  add.run('root', 'tui', null, '{}', 0, 0, 'compression', 100, 100, 'Fix the build', '/w/app', '', '', 'm1', 10)
  add.run('tip', 'tui', 'root', '{}', 0, 0, null, 900, 800, '', '/w/app/sub', '', 'feat/x', 'm2', 40)
  // A subagent run under it, a cron session, an archived one, a pinned archived one, an older plain one.
  add.run('child', 'subagent', 'root', '{"_delegate_from":"root"}', 0, 0, null, 950, 940, 'sub', '/w/app', '', '', 'm', 3)
  add.run('cron1', 'cron', null, '{}', 0, 0, null, 990, 990, 'cron', '/w', '', '', 'm', 2)
  add.run('gone', 'local', null, '{}', 1, 0, null, 980, 980, 'archived', '/w', '', '', 'm', 2)
  add.run('keep', 'local', null, '{}', 1, 1, null, 50, 50, 'pinned', '/w/other', '', '', 'm', 2)
  add.run('plain', 'cli', null, '{}', 0, 0, null, 500, 500, '', '/w/other', '', '', 'm', 4)
  const msg = conn.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)')
  msg.run('plain', 'user', '[OUT-OF-BAND USER MESSAGE] note\nWhy is CI red? Look at the logs.', 1)
  msg.run('root', 'assistant', 'old answer', 2)
  msg.run('tip', 'assistant', 'newest answer', 3)
  conn.close()

  return path
}

describe('storedSessions', () => {
  it('lists local roots only, folds a compression chain into its root with the tip data, newest first', () => {
    const rows = storedSessions(50, db())

    expect(rows.map(r => r.id)).toEqual(['root', 'plain', 'keep'])
    expect(rows[0]).toMatchObject({ branch: 'feat/x', cwd: '/w/app/sub', lastActive: 900_000, messages: 40, model: 'm2', title: 'Fix the build' })
    expect(rows[2]?.pinned).toBe(true)
  })

  it('reads the first prompt without Hermes markers', () => {
    expect(storedSessions(50, db()).find(r => r.id === 'plain')?.preview).toBe('Why is CI red? Look at the logs.')
  })

  it('lists a local conversation reset in place once, by its newest segment', () => {
    const path = db()
    const conn = new DatabaseSync(path)
    conn.exec('CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT)')
    const add = conn.prepare(`INSERT INTO sessions (id, source, parent_session_id, model_config, end_reason, last_activity_at,
      started_at, title, cwd, message_count) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    // Owner `own` was reset into `seg2`; `seg2` was compressed into `seg2b`, then reset into `seg3`.
    add.run('own', 'tui', null, '{}', 'session_reset', 300, 300, 'Start', '/w/a', 2)
    add.run('seg2', 'tui', 'own', '{"_reset_from":"own"}', 'compression', 400, 400, '', '/w/a', 3)
    add.run('seg2b', 'tui', 'seg2', '{}', 'session_reset', 450, 420, '', '/w/a', 5)
    add.run('seg3', 'tui', 'seg2b', '{"_reset_from":"seg2b"}', null, 1000, 600, 'Now', '/w/a', 1)
    conn.prepare('INSERT INTO state_meta VALUES (?, ?)').run(
      'gateway.local_policy.v1:own',
      JSON.stringify({ lineage: ['own', 'seg2', 'seg2b', 'seg3'], session_id: 'own' })
    )
    // A receipt with no reset yet lists its one row as before.
    conn.prepare('INSERT INTO state_meta VALUES (?, ?)').run('gateway.local_policy.v1:plain', JSON.stringify({ lineage: ['plain'], session_id: 'plain' }))
    conn.close()

    expect(storedSessions(50, path).map(r => r.id)).toEqual(['seg3', 'root', 'plain', 'keep'])
  })

  it('skips a receipt JavaScript cannot read, in place of losing the whole listing', () => {
    const receipts = [{ value: '{"lineage": ["a", "b"], ' }, { value: JSON.stringify({ lineage: ['a', 'b'], session_id: 'a' }) }]
    const segments = [
      { end_reason: 'session_reset', id: 'a' },
      { end_reason: null, id: 'b' }
    ]
    // SQLite's json_valid keeps such text out today; the reader does not lean on it.
    const conn = { prepare: (sql: string) => ({ all: () => (sql.includes('state_meta') ? receipts : segments) }) }

    expect(supersededSegments(conn)).toEqual(['a'])
  })

  it('is empty without a database', () => {
    expect(storedSessions(5, '/nonexistent/state.db')).toEqual([])
  })
})

describe('workspace and labels', () => {
  it('matches the repo root when known, else the folder or one under it', () => {
    expect(inWorkspace({ cwd: '/w/app/sub', repoRoot: '' }, '/w/app')).toBe(true)
    expect(inWorkspace({ cwd: '/w/app-two', repoRoot: '' }, '/w/app')).toBe(false)
    expect(inWorkspace({ cwd: '/elsewhere', repoRoot: '/w/app/' }, '/w/app')).toBe(true)
    expect(inWorkspace({ cwd: '/w/app', repoRoot: '/w/other' }, '/w/app')).toBe(false)
  })

  it('names a session by title, else its first sentence, else untitled', () => {
    expect(sessionLabel({ preview: 'x', title: 'T' })).toBe('T')
    expect(sessionLabel({ preview: 'Why is CI red? Look at the logs.', title: '' })).toBe('Why is CI red?')
    expect(sessionLabel({ preview: '', title: '' })).toBe('Untitled session')
  })
})
