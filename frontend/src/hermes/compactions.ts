// Where a conversation was compacted. `session.resume` leaves the handoff summary Hermes writes at
// each compaction out of its history, so a resumed transcript would not say where the agent's
// memory starts over. `session.transcript` puts each handoff back as a row of its own
// (hermes/sessionTranscript.ts reads it).

import type { Requester } from '../wire/rpc.js'

import { compactionOf, readTranscript } from './sessionTranscript.js'

/** A compaction the store knows of: when its summary was written (epoch ms), and the summary. */
export interface StoredCompaction {
  at: number
  summary?: string
  messages?: number
}

/** Rows per page of the whole read: the most `session.transcript` takes. */
const WHOLE_PAGE = 500
/** Pages the whole read takes at most (50,000 rows): a transcript that keeps restarting cannot hold it forever. */
const WHOLE_PAGES = 100
/** Rows of the newest page read after a live compaction: its handoff is near the end. */
const LATEST_PAGE = 100

/** The compactions on conversation `sid`'s newest page, oldest first: where a compaction that just ended shows. */
export async function latestCompactions(gw: Requester, sid: string): Promise<StoredCompaction[]> {
  const page = await readTranscript(gw, sid, null, LATEST_PAGE)

  return page.rows.flatMap(row => compactionOf(row) ?? [])
}

/**
 * Every compaction of conversation `sid`, oldest first: the whole transcript, newest page first,
 * one call per `WHOLE_PAGE` rows, at most `WHOLE_PAGES` calls (past that, the newer ones only).
 * Undefined once `wanted()` turns false (another session is shown).
 */
export async function allCompactions(gw: Requester, sid: string, wanted: () => boolean): Promise<StoredCompaction[] | undefined> {
  const pages: StoredCompaction[][] = []
  let cursor: string | null = null
  let calls = 0

  do {
    calls++
    const page = await readTranscript(gw, sid, cursor, WHOLE_PAGE)

    if (!wanted()) {
      return undefined
    }

    if (page.reset && cursor !== null) {
      // The gateway started over from the newest page: what was read before is stale.
      pages.length = 0
    }

    pages.unshift(page.rows.flatMap(row => compactionOf(row) ?? []))
    cursor = page.next_cursor
  } while (cursor && calls < WHOLE_PAGES)

  return pages.flat()
}

/** The token counts in one of Hermes' compaction lines ("~182,000 tokens", "~250,000 → ~120,000 tokens"). */
export function lineTokens(text: string): { before?: number | undefined; after?: number | undefined } {
  const num = (s: string) => Number(s.replace(/,/g, ''))
  const pair = /~(?<before>[\d,]+)\s*→\s*~(?<after>[\d,]+)\s*tok/.exec(text)?.groups

  if (pair) {
    return { after: num(pair['after'] ?? ''), before: num(pair['before'] ?? '') }
  }

  const one = /~(?<before>[\d,]+)\s*tok/.exec(text)?.groups

  return one ? { before: num(one['before'] ?? '') } : {}
}
