// Where a conversation was compacted. The gateway's history drops the handoff summary Hermes
// writes at each compaction (agent/compaction_display.py), so a resumed transcript would not say
// where the agent's memory starts over. The summary rows are still in the session store: read
// them for the session and the ones it continues (links.ts' `ancestry`), read-only.

import { DatabaseSync } from 'node:sqlite'

import { ancestry } from './github/links.js'
import { stateDbPath } from './watch/child.js'

/** A compaction the store knows of: when its summary was written (epoch ms), and the summary. */
export interface StoredCompaction {
  at: number
  summary?: string
  messages?: number
}

/** The start of every handoff summary (agent/context_compressor.py). */
const MARKER = '[CONTEXT COMPACTION'
const END = '--- END OF CONTEXT SUMMARY'
/** The section that tells the model how to search what was compacted, not what it remembers. */
const RECOVERY = /\n## Context Recovery\b[\s\S]*?(?=\n## |$)/
/** Lines that rank the summary for the model ("Historical only; …", "(Every real user message …)"). */
const FOR_MODEL = /^ *(?:Historical only;.*|\(Every real user message.*\)) *$|(?<=\S) *\(Every real user message[^)]*\)/gm

const QUERY = (n: number) => `SELECT timestamp, content FROM messages
  WHERE session_id IN (${Array(n).fill('?').join(', ')}) AND (active = 1 OR compacted = 1)
    AND role IN ('user', 'assistant') AND instr(content, '${MARKER}') > 0
  ORDER BY id`

/** The compactions of stored session `sid`'s conversation, oldest first; empty without the store. */
export function storedCompactions(sid: string, db = stateDbPath(), lineage: (sid: string) => string[] = ancestry): StoredCompaction[] {
  const ids = lineage(sid)

  try {
    const conn = new DatabaseSync(db, { readOnly: true })

    try {
      const rows = conn.prepare(QUERY(ids.length)).all(...ids) as { timestamp?: unknown; content?: unknown }[]
      const out = rows.flatMap(r => (typeof r.timestamp === 'number' ? [{ at: r.timestamp * 1000, ...handoff(r.content) }] : []))

      // A summary copied into the continuing session (a protected tail) is the same compaction.
      return out.filter((c, i) => !out.slice(0, i).some(o => o.summary === c.summary && Math.abs(o.at - c.at) < 60_000))
    } finally {
      conn.close()
    }
  } catch {
    // No store, or an older one without these columns: no boundaries, as before.
    return []
  }
}

/** A stored handoff's summary (its sections, no instructions to the model) and the messages it covers. */
export function handoff(content: unknown): Omit<StoredCompaction, 'at'> {
  const text = textOf(content)
  const from = text.indexOf(MARKER)

  if (from < 0) {
    return {}
  }

  const body = text.slice(from)
  const count = /\bThe (\d+) compacted message/.exec(body)
  const start = body.indexOf('\n## ')
  const end = body.indexOf(END)
  const summary = start < 0 ? '' : body.slice(start, end > start ? end : undefined).replace(RECOVERY, '').replace(FOR_MODEL, '').replace(/\n{3,}/g, '\n\n').trim()

  return { ...(summary ? { summary } : {}), ...(count ? { messages: Number(count[1]) } : {}) }
}

/** A stored row's text: a string, or the text parts of a JSON content list. */
function textOf(content: unknown): string {
  if (typeof content !== 'string') {
    return ''
  }

  if (!content.startsWith('[{')) {
    return content
  }

  try {
    const parts: unknown = JSON.parse(content)

    return Array.isArray(parts)
      ? parts.map(p => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('\n')
      : content
  } catch {
    return content
  }
}

/** The token counts in one of Hermes' compaction lines ("~182,000 tokens", "~250,000 → ~120,000 tokens"). */
export function lineTokens(text: string): { before?: number; after?: number } {
  const num = (s: string) => Number(s.replace(/,/g, ''))
  const pair = /~([\d,]+)\s*→\s*~([\d,]+)\s*tok/.exec(text)

  if (pair) {
    return { after: num(pair[2]!), before: num(pair[1]!) }
  }

  const one = /~([\d,]+)\s*tok/.exec(text)

  return one ? { before: num(one[1]!) } : {}
}
