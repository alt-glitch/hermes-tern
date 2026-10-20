// The PRs the agent linked to this conversation (`link_pull_request`, the plugin's own tool).
// The tool keeps them in `<HERMES_HOME>/plugin-data/hermes-tern/pull-requests.json` under the
// conversation's root session (pull_requests.py); a live turn's link calls carry the whole list in
// their results, so the sheet follows them without reading the file again.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import * as z from 'zod/mini'

import { stateDbPath } from '../hermes/paths.js'
import type { ToolCall } from '../model.js'
import { readLinksFile } from '../wire/files.js'
import { record } from '../wire/json.js'
import { first, text } from '../wire/sqlite.js'

import type { PrRef } from './pullRequest.js'

export const LINK_TOOLS = new Set(['link_pull_request', 'list_pull_requests', 'unlink_pull_request'])

export function linksPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HERMES_HOME || join(homedir(), '.hermes'), 'plugin-data', 'hermes-tern', 'pull-requests.json')
}

function refOf(v: unknown): PrRef | undefined {
  const r = record(v)
  const host = typeof r?.host === 'string' ? r.host : ''
  const repository = typeof r?.repository === 'string' ? r.repository : ''
  const number = typeof r?.number === 'number' ? r.number : 0

  return host && repository && number > 0
    ? { host, number, repository, url: typeof r?.url === 'string' ? r.url : `https://${host}/${repository}/pull/${number}` }
    : undefined
}

/** The list a link tool's result carries (`linked`), when the call succeeded. */
export function linkedFromResult(call: Pick<ToolCall, 'name' | 'outcome' | 'result'>): PrRef[] | undefined {
  if (!LINK_TOOLS.has(call.name) || call.outcome.kind !== 'done') {
    return undefined
  }

  const linked = record(call.result)?.linked

  return Array.isArray(linked) ? linked.map(refOf).filter((r): r is PrRef => Boolean(r)) : undefined
}

// The parent a session continues: one that ended in compression. A /branch, delegate, reset or tool
// child also names its parent, but it is its own conversation. Its marker names that parent (a
// continuation copies `model_config`, so a marker naming another row is inherited). Core's rule
// (get_compression_lineage, which the link tools in pull_requests.py use).
const marker = (k: string) => `COALESCE(json_extract(CASE WHEN json_valid(c.model_config) THEN c.model_config ELSE '{}' END, '$.${k}'), '') != p.id`
const CONTINUES = `SELECT p.id AS p FROM sessions c JOIN sessions p ON p.id = c.parent_session_id
  WHERE c.id = ? AND p.end_reason = 'compression' AND COALESCE(c.source, '') != 'tool'
    AND ${['_branched_from', '_delegate_from', '_reset_from'].map(marker).join(' AND ')}`

const parentRow = z.object({ p: text })

/**
 * Session `sid`'s ancestors, itself first: compression gives a conversation a new session whose
 * `parent_session_id` is the one it continues. Read-only, and empty when the database is not there.
 */
export function ancestry(sid: string, db = stateDbPath()): string[] {
  const chain = [sid]

  try {
    const conn = new DatabaseSync(db, { readOnly: true })

    try {
      const parent = conn.prepare(CONTINUES)

      for (let i = 0; i < 100; i++) {
        const p = first(parent, parentRow, chain.at(-1) ?? sid)?.p

        if (!p || chain.includes(p)) {
          break
        }

        chain.push(p)
      }
    } finally {
      conn.close()
    }
  } catch {
    // No database (another profile layout, a fresh install): the session alone.
  }

  return chain
}

/** The links stored for session `sid`'s conversation, oldest first. */
export function storedLinks(sid: string, file = linksPath(), lineage: (sid: string) => string[] = ancestry): PrRef[] {
  const data = readLinksFile(file)

  if (!data) {
    return []
  }

  const { aliases, conversations } = data
  const root = lineage(sid).find(id => aliases[id] || conversations[id])

  if (!root) {
    return []
  }

  const links = conversations[aliases[root] ?? root]

  return Array.isArray(links) ? links.map(refOf).filter((r): r is PrRef => Boolean(r)) : []
}
