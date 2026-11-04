import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it, vi } from 'vitest'

import { liveSessionId, storedSessionId } from '../core/ids.js'
import { type BranchFamily, branchFamily, type BranchNode, treeRows } from '../hermes/sessionTree.js'
import type { Overlay } from '../overlays/overlay.js'
import { openBranchTree, type TreeHost } from '../overlays/tree.js'
import { Transcript } from '../transcript/store.js'

import { key, must, tree } from './fakes.js'

type Row = [id: string, parent: string | null, config: string, endReason: string | null, started: number, title: string, messages?: number]

function db(sessions: readonly Row[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'tern-tree-')), 'state.db')
  const conn = new DatabaseSync(path)
  conn.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, parent_session_id TEXT, model_config TEXT,
    archived INTEGER DEFAULT 0, end_reason TEXT, last_activity_at REAL, ended_at REAL, started_at REAL,
    display_name TEXT, title TEXT, message_count INTEGER);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL);`)
  const add = conn.prepare(`INSERT INTO sessions (id, source, parent_session_id, model_config, end_reason, last_activity_at,
    ended_at, started_at, title, message_count) VALUES (?,?,?,?,?,?,?,?,?,?)`)

  for (const [id, parent, config, end, started, title, messages = 2] of sessions) {
    add.run(id, config.includes('_delegate_from') ? 'subagent' : 'tui', parent, config, end, started + 5, end ? started + 1 : null, started, title, messages)
  }

  conn.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)').run('root', 'user', 'Fix the build', 1)
  conn.close()

  return path
}

/**
 * A conversation compressed once (root → tip), two branches of it (one made from the continuation),
 * a branch of a branch, a subagent run, a reset segment, and an older branch known only by its
 * parent ending 'branched'.
 */
const FAMILY: Row[] = [
  ['root', null, '{}', 'compression', 100, 'Fix the build', 4],
  ['tip', 'root', '{}', null, 200, '', 30],
  ['b1', 'tip', '{"_branched_from":"tip"}', null, 300, 'Try plan B'],
  ['b2', 'root', '{"_branched_from":"root"}', null, 250, 'Try plan C'],
  ['b1a', 'b1', '{"_branched_from":"b1"}', null, 400, 'Plan B, smaller'],
  ['agent', 'b1', '{"_delegate_from":"b1"}', null, 410, 'subagent'],
  ['reset', 'b2', '{"_reset_from":"b2"}', null, 420, 'Reset segment'],
  ['old', null, '{}', 'branched', 10, 'Legacy parent'],
  ['old-b', 'old', '{}', null, 20, 'Legacy branch']
]

const shape = (f: BranchFamily) => ({ at: f.at, nodes: f.nodes.map(n => [n.id, n.parent]) })

describe('branchFamily', () => {
  it("reads the whole family from any member, a continuation folded into its conversation's root", () => {
    const path = db(FAMILY)
    const want = {
      nodes: [
        ['root', null],
        ['b2', 'root'],
        ['b1', 'root'],
        ['b1a', 'b1']
      ]
    }

    expect(shape(branchFamily('b1a', path))).toEqual({ at: 'b1a', ...want })
    expect(shape(branchFamily('tip', path))).toEqual({ at: 'root', ...want })
    // The conversation's facts come from its newest segment.
    expect(branchFamily('root', path).nodes[0]).toMatchObject({ messages: 30, preview: 'Fix the build', title: 'Fix the build' })
  })

  it("leaves out subagent runs and reset segments, and keeps a branch known only by its parent's end", () => {
    const path = db(FAMILY)

    expect(shape(branchFamily('reset', path))).toEqual({ at: 'reset', nodes: [['reset', null]] })
    expect(shape(branchFamily('old-b', path))).toEqual({
      at: 'old-b',
      nodes: [
        ['old', null],
        ['old-b', 'old']
      ]
    })
  })

  it('cuts a lineage that loops at its smallest id, whichever member reads it', () => {
    const path = db([
      ['y', 'x', '{"_branched_from":"x"}', null, 1, 'Y'],
      ['x', 'y', '{"_branched_from":"y"}', null, 2, 'X']
    ])

    const cut = [
      ['x', null],
      ['y', 'x']
    ]

    expect(shape(branchFamily('x', path))).toEqual({ at: 'x', nodes: cut })
    expect(shape(branchFamily('y', path))).toEqual({ at: 'y', nodes: cut })
  })

  it('is empty for a session that is not stored, or no database', () => {
    expect(branchFamily('nope', db(FAMILY))).toEqual({ at: null, nodes: [] })
    expect(branchFamily('root', join(tmpdir(), 'no-such-dir', 'state.db'))).toEqual({ at: null, nodes: [] })
  })
})

const node = (id: string, parent: string | null, startedAt: number): BranchNode => ({
  archived: false,
  id,
  lastActive: startedAt,
  messages: 2,
  parent,
  preview: '',
  startedAt,
  title: id
})

describe('treeRows', () => {
  it('puts each branch under its parent, siblings oldest first, with its depth and branch count', () => {
    const rows = treeRows([node('b1a', 'b1', 4), node('b1', 'root', 3), node('root', null, 1), node('b2', 'root', 2)])

    expect(rows.map(r => [r.node.id, r.depth, r.children])).toEqual([
      ['root', 0, 2],
      ['b2', 1, 0],
      ['b1', 1, 1],
      ['b1a', 2, 0]
    ])
  })
})

function host(stored: string) {
  const opened: Overlay[] = []
  const transcript = new Transcript()
  const h = {
    changed: vi.fn(),
    close: vi.fn((o: Overlay) => void opened.splice(opened.indexOf(o), 1)),
    open: (o: Overlay) => void opened.push(o),
    resume: vi.fn(async () => undefined),
    session: { info: null, ref: { live: liveSessionId('live-1'), stored: storedSessionId(stored) } },
    transcript
  } satisfies TreeHost

  return { h, opened, transcript }
}

const FAKE: BranchFamily = { at: 'b1', nodes: [node('root', null, 1), node('b1', 'root', 3), node('b2', 'root', 2)] }

describe('the branch tree', () => {
  it('marks the open conversation and opens another with Enter', () => {
    const { h, opened } = host('b1')

    openBranchTree(h, () => FAKE)
    const sheet = must(opened[0])
    const p = must(tree(sheet.node('layer.tree')).p)

    expect(p['layout']).toBe('tree')
    expect(p['order']).toEqual(['root', 'b2', 'b1'])
    expect(p['current']).toEqual(['b1'])
    expect(p['selected']).toBe('b1')

    sheet.onKey(key('up'))
    sheet.onKey(key('enter'))

    expect(h.resume).toHaveBeenCalledWith('b2')
    expect(opened).toEqual([])
  })

  it('Enter on the open conversation only closes the sheet', () => {
    const { h, opened } = host('b1')

    openBranchTree(h, () => FAKE)
    must(opened[0]).onKey(key('enter'))

    expect(h.resume).not.toHaveBeenCalled()
    expect(opened).toEqual([])
  })

  it('says so, and opens nothing, for a conversation with no branches', () => {
    const { h, opened, transcript } = host('solo')

    openBranchTree(h, () => ({ at: 'solo', nodes: [node('solo', null, 1)] }))

    expect(opened).toEqual([])
    expect(transcript.entries.at(-1)).toMatchObject({ kind: 'notice', text: 'This conversation has no branches yet. /branch makes one.' })
  })
})
