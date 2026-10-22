import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import { contentText, promptText, readSessionEnds, readTranscriptPage, skillPrompt } from '../hermes/sessionTranscript.js'

function tempDb(): { path: string; conn: DatabaseSync } {
  const path = join(mkdtempSync(join(tmpdir(), 'tern-transcript-')), 'state.db')

  return { conn: new DatabaseSync(path), path }
}

/** A compressed conversation (root → tip), a branch off the root, and rows a display read hides. */
function db(): string {
  const { conn, path } = tempDb()
  conn.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, model_config TEXT, end_reason TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT,
      tool_calls TEXT, tool_name TEXT, timestamp REAL, active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0,
      display_kind TEXT, display_metadata TEXT);`)
  const session = conn.prepare('INSERT INTO sessions VALUES (?,?,?,?)')
  session.run('root', null, '{}', 'compression')
  session.run('tip', 'root', '{}', null)
  session.run('fork', 'root', '{"_branched_from":"root"}', null)
  const msg = conn.prepare(`INSERT INTO messages (session_id, role, content, tool_calls, timestamp, active, compacted, display_kind, display_metadata)
    VALUES (?,?,?,?,?,?,?,?,?)`)
  const calls = JSON.stringify([{ function: { arguments: '{"path":"src/app.ts"}', name: 'read_file' }, id: 'c1' }])
  msg.run('root', 'user', '[OUT-OF-BAND USER MESSAGE] note\nFix the build\n@image:/tmp/a.png', null, 1, 1, 0, null, null)
  msg.run('root', 'assistant', '', calls, 2, 1, 0, null, null)
  msg.run('root', 'tool', '{"content":"…"}', null, 3, 1, 0, null, null)
  msg.run('root', 'assistant', 'Looking at it.', null, 4, 0, 1, null, null)
  msg.run('root', 'assistant', 'model only', null, 5, 1, 0, null, '{"model_only":true}')
  msg.run('root', 'user', 'undone prompt', null, 6, 0, 0, null, null)
  msg.run('tip', 'user', '[CONTEXT COMPACTION] summary …', null, 7, 1, 0, null, null)
  // The protected tail a compaction copies into the continuation: shown once.
  msg.run('tip', 'assistant', 'Looking at it.', null, 4, 1, 0, null, null)
  msg.run('tip', 'user', 'also run the tests', null, 8, 1, 0, 'steer', null)
  msg.run('tip', 'user', '[SYSTEM: Background process completed]\nexit 0', null, 9, 1, 0, 'process_complete', null)
  msg.run('tip', 'assistant', 'hidden', null, 10, 1, 0, 'hidden', null)
  msg.run('tip', 'assistant', '\x00json:[{"type":"text","text":"Done: the build is green."}]', null, 11, 1, 0, null, null)
  msg.run('fork', 'assistant', 'a branch reply', null, 12, 1, 0, null, null)
  conn.close()

  return path
}

describe('readTranscriptPage', () => {
  it('reads the conversation across its compression chain, a tool call per line, hidden rows out', () => {
    const page = readTranscriptPage('root', 0, 100, db())

    expect(page.next).toBeNull()
    expect(page.rows.map(r => [r.kind, 'text' in r ? r.text : 'name' in r ? r.name : ''])).toEqual([
      ['user', 'Fix the build'],
      ['tool', 'read_file'],
      ['assistant', 'Looking at it.'],
      ['note', 'Context compacted: the agent continued from a summary.'],
      ['assistant', 'Looking at it.'],
      ['user', 'also run the tests'],
      ['note', 'Background process completed'],
      ['assistant', 'Done: the build is green.']
    ])
    expect(page.rows[5]).toMatchObject({ kind: 'user', steer: true })
    expect(page.rows[1]).toMatchObject({ args: { path: 'src/app.ts' }, kind: 'tool' })
    // The copied tail carries the original's key, so the loader keeps one of the two.
    expect(page.rows[4]?.key).toBe(page.rows[2]?.key)
  })

  it('pages by row id: the cursor is the last row read, null at the end', () => {
    const path = db()
    const one = readTranscriptPage('root', 0, 3, path)
    const two = readTranscriptPage('root', one.next ?? -1, 3, path)

    expect(one.next).toBe(3)
    expect(one.rows.map(r => r.kind)).toEqual(['user', 'tool'])
    expect(two.rows.map(r => r.kind)).toEqual(['assistant', 'note', 'assistant'])
    expect(readTranscriptPage('root', 100, 3, path)).toEqual({ next: null, rows: [] })
  })

  it('reads an older database without the display columns', () => {
    const { conn, path } = tempDb()
    conn.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, model_config TEXT, end_reason TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL);
      INSERT INTO sessions VALUES ('s', NULL, NULL, NULL);
      INSERT INTO messages (session_id, role, content, timestamp) VALUES ('s', 'user', 'hi', 1), ('s', 'assistant', 'hello', 2);`)
    conn.close()

    expect(readTranscriptPage('s', 0, 10, path).rows.map(r => r.kind)).toEqual(['user', 'assistant'])
    expect(readSessionEnds('s', path)).toEqual({ firstPrompt: 'hi', lastReply: 'hello' })
  })

  it('throws without a database, for the loader to show', () => {
    expect(() => readTranscriptPage('s', 0, 10, '/nonexistent/state.db')).toThrow()
  })
})

describe('readSessionEnds', () => {
  it('reads the whole first typed prompt and the last reply from the newest segment', () => {
    expect(readSessionEnds('root', db())).toEqual({ firstPrompt: 'Fix the build', lastReply: 'Done: the build is green.' })
  })

  it('reads text out of structured content', () => {
    expect(contentText('\x00json:[{"type":"text","text":"a"},{"type":"image_url"},{"type":"text","text":"b"}]')).toBe('a\nb')
    expect(contentText('plain')).toBe('plain')
    expect(contentText(null)).toBe('')
  })
})

describe('skillPrompt', () => {
  const head = '[IMPORTANT: The user has invoked the "work" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]\n\n---\nname: work\n---\nBody that quotes The user has provided the following instruction alongside the skill invocation: not this\n\n'

  it('reads a /skill turn as the user typed it', () => {
    expect(skillPrompt(`${head}The user has provided the following instruction alongside the skill invocation: fix the title leak\n\n[Runtime note: x]`)).toBe(
      '/work fix the title leak'
    )
    expect(skillPrompt(head.slice(0, head.indexOf('Body')))).toBe('/work')
    expect(skillPrompt('[IMPORTANT: The user has invoked the "/a /b" skill bundle, …]\nUser instruction: ship it\n\n[Loaded as part of the bundle]')).toBe('/a /b ship it')
    expect(skillPrompt('plain prompt')).toBe('plain prompt')
  })

  it('reads an attached image as [image], not its cache path', () => {
    expect(promptText('look at this\n\n[Image attached at: /h/cache/a.png]\n@image:/tmp/b.png')).toBe('look at this\n\n[image]')
  })
})
