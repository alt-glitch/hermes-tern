import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { TranscriptMessage } from '@hermes/shared/gateway-events'
import { describe, expect, it } from 'vitest'

import { handoff, lineTokens, storedCompactions } from '../compaction.js'
import type { Compaction, Entry, TurnEntry } from '../model.js'
import { Transcript } from '../transcript.js'
import { parts } from '../workLog.js'

const HANDOFF = [
  '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. Respond ONLY to the latest user message.',
  '## Goal',
  'Ship the parity pass.',
  '',
  '## Context Recovery',
  "The 419 compacted message(s) remain fully preserved in session history. Use session_search(query='…').",
  '',
  '--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---'
].join('\n')

const lastTurn = (entries: readonly Entry[]) => entries.findLast((e): e is TurnEntry => e.kind === 'turn')!

/** Each entry's kind; a turn lists its blocks' kinds. */
const shape = (entries: readonly Entry[]) => entries.map(e => (e.kind === 'turn' ? `turn(${e.blocks.map(b => b.kind).join()})` : e.kind))

const compactions = (t: Transcript): Compaction[] =>
  t.entries.flatMap(e =>
    e.kind === 'compaction' ? [e.compaction] : e.kind === 'turn' ? e.blocks.flatMap(b => (b.kind === 'compaction' ? [b.compaction] : [])) : []
  )

describe('the handoff summary', () => {
  it('keeps what the agent remembers, not the instructions to it or the recovery note', () => {
    expect(handoff(HANDOFF)).toEqual({ messages: 419, summary: '## Goal\nShip the parity pass.' })
    // A summary merged into the next prompt starts after it.
    expect(handoff(`look at this\n\n${HANDOFF}`).summary).toBe('## Goal\nShip the parity pass.')
    expect(handoff(JSON.stringify([{ text: HANDOFF, type: 'text' }])).messages).toBe(419)
    expect(handoff('just a prompt')).toEqual({})

    const ranked = HANDOFF.replace(
      '## Goal',
      "## Historical Task Snapshot\nUser asked: 'hi'\nHistorical only; newer protected-tail messages after this summary win.\n\n## Goal"
    ).replace('## Context Recovery', "## User Messages\n> hi (Every real user message from the compacted region, quoted verbatim.)\n\n## Context Recovery")
    expect(handoff(ranked).summary).toBe("## Historical Task Snapshot\nUser asked: 'hi'\n\n## Goal\nShip the parity pass.\n\n## User Messages\n> hi")
  })

  it("reads the token counts in Hermes' lines", () => {
    expect(lineTokens('💤 Resumed after 600s idle — compacting ~51,200 tokens before continuing.')).toEqual({ before: 51200 })
    expect(lineTokens('🗜️ Compacting context — summarizing earlier conversation so I can continue...')).toEqual({})
  })
})

describe('stored compactions', () => {
  it("reads the summaries of the session and the ones it continues, once each, in order", () => {
    const db = join(mkdtempSync(join(tmpdir(), 'tern-compaction-')), 'state.db')
    const conn = new DatabaseSync(db)
    conn.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER, compacted INTEGER)')
    const add = conn.prepare('INSERT INTO messages (session_id, role, content, timestamp, active, compacted) VALUES (?,?,?,?,?,?)')
    add.run('root', 'user', 'hello', 100, 0, 1)
    add.run('tip', 'user', HANDOFF, 200, 1, 0)
    // The same summary copied with the protected tail, and one an undo took back.
    add.run('tip', 'user', HANDOFF, 201, 1, 0)
    add.run('tip', 'user', HANDOFF.replace('parity', 'other'), 300, 0, 0)
    add.run('elsewhere', 'user', HANDOFF, 150, 1, 0)
    conn.close()

    expect(storedCompactions('tip', db, () => ['tip', 'root'])).toEqual([{ at: 200_000, messages: 419, summary: '## Goal\nShip the parity pass.' }])
    expect(storedCompactions('tip', join(db, 'missing'), () => ['tip'])).toEqual([])
  })
})

describe('compaction in the transcript', () => {
  it('is a step of the turn it happened in, and a split its fold leaves in view', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.text('reading the repo', 1)
    t.compacting({ at: 1_000, before: 182_000 })

    const c = compactions(t)[0]!
    expect(shape(t.entries)).toEqual(['turn(text,compaction)'])
    expect(c).toMatchObject({ before: 182_000, startedAt: 1_000, status: 'running' })

    // A later line of the same compaction does not start another.
    t.compacting({ at: 2_000, before: 190_000 })
    t.compacted(13_000)
    t.text('done', 14_000)
    t.complete({ status: 'complete', text: 'done' }, 20_000)
    t.uncompact('running')

    expect(compactions(t)).toEqual([expect.objectContaining({ before: 182_000, endedAt: 13_000, status: 'done' })])
    expect(parts(lastTurn(t.entries)).map(p => (p.kind === 'fold' ? `fold:${p.label}` : p.blocks.map(b => b.kind).join()))).toEqual([
      'fold:Worked for 1.0s',
      'compaction,text'
    ])
  })

  it('goes before the turn it was compacted for, and between turns for /compress', () => {
    const t = new Transcript()
    t.user({ at: 0, text: 'go on' })
    t.messageStart(1)
    t.compacting({ at: 2 })
    expect(shape(t.entries)).toEqual(['user', 'compaction', 'turn()'])
    t.compacted(3)
    t.complete({ status: 'complete', text: 'ok' }, 4)

    t.compacting({ at: 10, before: 50_000, manual: true })
    expect(shape(t.entries)).toEqual(['user', 'compaction', 'turn(text)', 'compaction'])
    expect(compactions(t)[1]).toMatchObject({ manual: true })
  })

  it('takes the first lower context reading as what it left, and the stored summary', () => {
    const t = new Transcript()
    t.compacting({ at: 1_000, before: 180_000 })
    t.contextUsed(170_000)
    t.compacted(5_000)
    // A stale reading is not what it left.
    t.contextUsed(180_000)
    t.contextUsed(41_000)
    t.contextUsed(42_000)
    expect(compactions(t)[0]).toMatchObject({ after: 41_000, before: 180_000 })

    expect(t.unsummarized).toBe(true)
    // Summaries written well before or after it are other compactions'.
    t.summarize([{ at: 100_000, summary: 'later' }])
    expect(t.unsummarized).toBe(true)
    t.summarize([{ at: 6_000, messages: 12, summary: '## Goal' }])
    expect(compactions(t)[0]).toMatchObject({ messages: 12, summary: '## Goal' })
    expect(t.unsummarized).toBe(false)
  })

  it('drops a compaction Hermes aborted (no done edge before the turn ended)', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.text('x', 1)
    t.compacting({ at: 2, before: 1 })
    t.complete({ status: 'complete', text: 'x' }, 3)
    t.uncompact('running')
    expect(shape(t.entries)).toEqual(['turn(text)'])

    const done = t.compacting({ at: 4, before: 1 })
    t.compacted(5)
    t.uncompact('running')
    expect(shape(t.entries)).toEqual(['turn(text)', 'compaction'])
    t.uncompact(done)
    expect(shape(t.entries)).toEqual(['turn(text)'])
  })

  it('puts stored compactions where they happened on resume, keeping what this view saw', () => {
    const at = (s: number) => s
    const messages: TranscriptMessage[] = [
      { role: 'user', text: 'first', timestamp: at(10) },
      { role: 'assistant', text: 'one', timestamp: at(11) },
      // Compacted at 15: between turns.
      { role: 'user', text: 'second', timestamp: at(20) },
      { name: 'terminal', role: 'tool', timestamp: at(21), tool_call_id: 'c1' },
      // Compacted at 25: inside the turn, which went on.
      { role: 'assistant', text: 'two', timestamp: at(30) }
      // Compacted at 40, after everything: /compress.
    ]

    const t = new Transcript()
    // This view saw the one at 25 happen.
    t.compacting({ at: 24_000, before: 90_000 })
    t.compacted(26_000, { after: 20_000 })
    t.load(messages, [
      { at: 40_000, summary: 'c' },
      { at: 15_000, summary: 'a' },
      { at: 25_000, messages: 3, summary: 'b' }
    ])

    expect(shape(t.entries)).toEqual(['user', 'turn(text)', 'compaction', 'user', 'turn(tool,compaction,text)', 'compaction'])
    expect(compactions(t).map(c => c.summary)).toEqual(['a', 'b', 'c'])
    expect(compactions(t)[1]).toMatchObject({ after: 20_000, before: 90_000, messages: 3 })
    expect(t.unsummarized).toBe(false)
  })

  it('does not count a compaction as the turn the next one continues', () => {
    const t = new Transcript()
    t.messageStart(0)
    t.complete({ status: 'complete', text: 'a' }, 1)
    t.compacting({ at: 2, before: 1, manual: true })
    t.compacted(3)
    expect(t.messageStart(4).continued).toBe('Continued on its own')
  })
})
