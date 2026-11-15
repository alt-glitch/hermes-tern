// A conversation's branches, read from the profile's `state.db` (read-only; the shared gateway
// serves no lineage). Hermes keeps a branch as a copied session: its parent_session_id names the
// session it copied, and its model_config carries `_branched_from` (an older branch is known only
// by its parent ending 'branched' before it started, as hermes_state_sessions.py also reads it).
// The tree is that copy lineage, folded the way the session picker folds it: a compression
// continuation belongs to its root, and subagent runs, tool sessions and reset segments stay out.
// Where in its parent a branch was cut is not recorded, so nothing here guesses it.

import { DatabaseSync } from 'node:sqlite'

import * as z from 'zod/mini'

import { first, real, rows, text } from '../wire/sqlite.js'

import { stateDbPath } from './paths.js'

/** One conversation of a branch family: a chain root, its continuations folded in. */
export interface BranchNode {
  /** The chain root's id: what `session.resume` takes. */
  id: string
  /** The conversation it was branched from; null for the family's root. */
  parent: string | null
  title: string
  /** The first prompt, flattened. */
  preview: string
  /** Epoch ms. */
  startedAt: number
  lastActive: number
  messages: number
  archived: boolean
}

/** A branch family, and the node whose conversation holds the session it was read for. */
export interface BranchFamily {
  nodes: BranchNode[]
  at: string | null
}

/** One row of the tree as it is drawn: a node, how deep it sits and how many branches it has. */
export interface TreeRow {
  node: BranchNode
  depth: number
  children: number
}

const COLUMNS = `s.id, s.parent_session_id AS parent, s.end_reason, s.started_at, s.ended_at, s.source,
  json_extract(s.model_config, '$._branched_from') AS branched,
  json_extract(s.model_config, '$._delegate_from') AS delegated,
  json_extract(s.model_config, '$._reset_from') AS reset`

const edgeRow = z.object({
  id: z.string(),
  parent: text,
  end_reason: text,
  started_at: real,
  ended_at: real,
  source: text,
  branched: z.optional(z.unknown()),
  delegated: z.optional(z.unknown()),
  reset: z.optional(z.unknown())
})

type Edge = z.infer<typeof edgeRow>

const detailRow = z.object({
  title: text,
  archived: z.optional(z.unknown()),
  preview: text
})

const spanRow = z.object({ last_active: real, messages: z.optional(z.unknown()) })

const present = (v: unknown) => v !== undefined && v !== null

/** What the edge from `child` up to `parent` is. */
function kindOf(child: Edge, parent: Edge | undefined): 'branch' | 'continuation' | 'other' {
  if (!parent || present(child.delegated) || present(child.reset) || child.source === 'tool' || child.source === 'subagent') {
    return 'other'
  }

  if (present(child.branched)) {
    return 'branch'
  }

  if (parent.end_reason === 'branched' && (child.started_at ?? 0) >= (parent.ended_at ?? Infinity)) {
    return 'branch'
  }

  return parent.end_reason === 'compression' ? 'continuation' : 'other'
}

/** Hermes wraps steers and notices in markers; the tree wants the words. */
const flat = (s: string | null | undefined) =>
  (s ?? '')
    .replace(/^\[[A-Z][A-Z -]+\][^\n]*\n?/gm, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * The branch family of stored session `id`: every conversation reachable from it through branch
 * edges, up to the family's root and down to every branch of a branch, and the node holding `id`
 * (its compression chain's root). No nodes when the session is not stored, or there is no database. A damaged lineage that loops is cut at the smallest id in
 * the loop, so every member of it sees the same tree.
 */
export function branchFamily(id: string, db = stateDbPath()): BranchFamily {
  let conn: DatabaseSync | undefined

  try {
    conn = new DatabaseSync(db, { readOnly: true })
    const one = conn.prepare(`SELECT ${COLUMNS} FROM sessions s WHERE s.id = ?`)
    const kids = conn.prepare(`SELECT ${COLUMNS} FROM sessions s WHERE s.parent_session_id = ? ORDER BY s.started_at, s.id`)
    const cache = new Map<string, Edge | undefined>()
    const get = (sid: string | null): Edge | undefined => {
      if (!sid) {
        return undefined
      }

      if (!cache.has(sid)) {
        cache.set(sid, first(one, edgeRow, sid))
      }

      return cache.get(sid)
    }

    /** The root of the compression chain holding `sid`. */
    const chainRoot = (sid: string): string => {
      const seen = new Set<string>()
      let at = sid

      for (let row = get(at); row && !seen.has(at); row = get(at)) {
        seen.add(at)

        if (kindOf(row, get(row.parent)) !== 'continuation' || !row.parent) {
          break
        }

        at = row.parent
      }

      return at
    }

    if (!get(id)) {
      return { at: null, nodes: [] }
    }

    // Up: chain roots through branch edges, to the family's root.
    const at = chainRoot(id)
    const path: string[] = []
    let top = at

    for (;;) {
      const loop = path.indexOf(top)

      if (loop >= 0) {
        top = path.slice(loop).sort()[0] ?? top

        break
      }

      path.push(top)
      const row = get(top)

      if (!row?.parent || kindOf(row, get(row.parent)) !== 'branch') {
        break
      }

      top = chainRoot(row.parent)
    }

    // Down: each conversation's segments, and the branches made from any of them.
    const nodes: BranchNode[] = []
    const placed = new Set<string>()
    const queue: { root: string; parent: string | null }[] = [{ parent: null, root: top }]

    for (let next = queue.shift(); next; next = queue.shift()) {
      if (placed.has(next.root)) {
        continue
      }

      placed.add(next.root)
      const segments = [next.root]

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i] ?? ''

        for (const child of rows(kids, edgeRow, seg)) {
          cache.set(child.id, child)
          const kind = kindOf(child, get(seg))

          if (kind === 'continuation' && !segments.includes(child.id)) {
            segments.push(child.id)
          } else if (kind === 'branch' && !placed.has(child.id)) {
            queue.push({ parent: next.root, root: child.id })
          }
        }
      }

      nodes.push(nodeOf(conn, next.root, next.parent, segments, get(next.root)))
    }

    return { at, nodes }
  } catch {
    return { at: null, nodes: [] }
  } finally {
    conn?.close()
  }
}

/** A conversation's title, first prompt and activity, its continuations' activity included. */
function nodeOf(conn: DatabaseSync, root: string, parent: string | null, segments: readonly string[], row: Edge | undefined): BranchNode {
  const marks = segments.map(() => '?').join(',')
  const detail = first(
    conn.prepare(
      `SELECT COALESCE(NULLIF(s.display_name, ''), s.title, '') AS title, COALESCE(s.archived, 0) AS archived,
        (SELECT m.content FROM messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY m.id LIMIT 1) AS preview
       FROM sessions s WHERE s.id = ?`
    ),
    detailRow,
    root
  )
  const span = first(
    conn.prepare(
      `SELECT MAX(COALESCE(last_activity_at, ended_at, started_at)) AS last_active,
        (SELECT message_count FROM sessions WHERE id IN (${marks}) ORDER BY started_at DESC LIMIT 1) AS messages
       FROM sessions WHERE id IN (${marks})`
    ),
    spanRow,
    ...segments,
    ...segments
  )

  return {
    archived: detail?.archived === 1,
    id: root,
    lastActive: Math.round((span?.last_active ?? row?.started_at ?? 0) * 1000),
    messages: Number(span?.messages) || 0,
    parent,
    preview: flat(detail?.preview).slice(0, 400),
    startedAt: Math.round((row?.started_at ?? 0) * 1000),
    title: (detail?.title ?? '').trim()
  }
}

/** The family as the tree draws it: each node under its parent, siblings oldest first. */
export function treeRows(nodes: readonly BranchNode[]): TreeRow[] {
  const ids = new Set(nodes.map(n => n.id))
  const under = new Map<string | null, BranchNode[]>()

  for (const n of nodes) {
    const parent = n.parent && ids.has(n.parent) ? n.parent : null
    under.set(parent, [...(under.get(parent) ?? []), n])
  }

  for (const list of under.values()) {
    list.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1))
  }

  const out: TreeRow[] = []
  const seen = new Set<string>()
  const stack = [...(under.get(null) ?? [])].reverse().map(node => ({ depth: 0, node }))

  for (let at = stack.pop(); at; at = stack.pop()) {
    if (seen.has(at.node.id)) {
      continue
    }

    seen.add(at.node.id)
    const children = under.get(at.node.id) ?? []
    out.push({ children: children.length, depth: at.depth, node: at.node })
    stack.push(...[...children].reverse().map(node => ({ depth: at.depth + 1, node })))
  }

  return out
}
