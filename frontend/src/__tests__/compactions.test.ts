import { describe, expect, it } from 'vitest'

import { type EntryId, entryId } from '../core/ids.js'
import type { Entry, TurnEntry } from '../model.js'
import { Compactions } from '../transcript/compactions.js'

/** A Compactions over a plain entry list, as a transcript holds one. */
function setup(entries: Entry[] = [], live?: TurnEntry) {
  let next = 0
  const id = (prefix: string): EntryId => entryId(`${prefix}${next++}`)
  const compactions = new Compactions({ entries: () => entries, id, live: () => live })

  return { compactions, entries }
}

const turn = (over: Partial<TurnEntry> = {}): TurnEntry => ({ blocks: [], id: entryId('t'), kind: 'turn', rev: 0, startedAt: 0, status: 'live', ...over })

describe('Compactions', () => {
  it('puts a compaction between turns, before the empty live turn it was compacted for', () => {
    const live = turn()
    const { compactions, entries } = setup([live], live)

    compactions.compacting({ at: 1_000, before: 90_000 })

    expect(entries.map(e => e.kind)).toEqual(['compaction', 'turn'])
    expect(entries[0]).toMatchObject({ compaction: { before: 90_000, startedAt: 1_000, status: 'running' }, rev: 0 })
  })

  it('makes it a step of a live turn that already did something, and bumps that turn', () => {
    const live = turn({ blocks: [{ id: entryId('x'), kind: 'text', text: 'reading' }] })
    const { compactions, entries } = setup([live], live)

    compactions.compacting({ at: 5 })
    compactions.compacting({ before: 70_000, manual: true })

    expect(entries).toHaveLength(1)
    expect(live.blocks.map(b => b.kind)).toEqual(['text', 'compaction'])
    // A later line of the same compaction only fills in the count.
    expect(live.blocks[1]).toMatchObject({ compaction: { before: 70_000, manual: true, status: 'running' } })
    expect(live.rev).toBe(2)
  })

  it('ends the running one, and takes the context reading after it as what it left', () => {
    const { compactions, entries } = setup()

    compactions.compacting({ at: 0, before: 100_000 })
    compactions.compacted(10)
    // A stale tick from before it finished is not lower: skipped.
    compactions.contextUsed(99_000)
    compactions.contextUsed(20_000)
    compactions.contextUsed(30_000)

    expect(entries).toEqual([
      { compaction: { after: 20_000, before: 100_000, endedAt: 10, startedAt: 0, status: 'done' }, id: 'z0', kind: 'compaction', rev: 2 }
    ])
  })

  it('claims the nearest stored summary for each one seen, once, and only for a finished one', () => {
    const { compactions } = setup()

    compactions.compacting({ at: 1_000 })
    compactions.compacted(2_000)
    expect(compactions.unsummarized).toBe(true)

    compactions.summarize([
      { at: 60_000, summary: 'far' },
      { at: 2_500, messages: 9, summary: 'near' }
    ])

    expect(compactions.unsummarized).toBe(false)

    // A reload shows the seen one with its numbers, and the unclaimed one from the store alone.
    const restored = compactions.restore([
      { at: 60_000, summary: 'far' },
      { at: 2_500, messages: 9, summary: 'near' }
    ])

    expect(restored).toEqual([
      { at: 2_500, compaction: { endedAt: 2_000, messages: 9, startedAt: 1_000, status: 'done', summary: 'near' } },
      { at: 60_000, compaction: { startedAt: 60_000, status: 'done', summary: 'far' } }
    ])
  })

  it('leaves a running one unclaimed', () => {
    const { compactions } = setup()

    compactions.compacting({ at: 1_000 })

    expect(compactions.restore([{ at: 1_500, summary: 's' }])).toEqual([{ at: 1_500, compaction: { startedAt: 1_500, status: 'done', summary: 's' } }])
  })

  it('takes back the last one: an entry, or a step of the turn holding it', () => {
    const live = turn({ blocks: [{ id: entryId('x'), kind: 'text', text: 'go' }] })
    const { compactions } = setup([live], live)

    compactions.compacting({ at: 1 })
    compactions.compacted(2)
    // `running` drops only a running one.
    compactions.uncompact(true)
    expect(live.blocks.map(b => b.kind)).toEqual(['text', 'compaction'])

    compactions.uncompact()
    expect(live.blocks.map(b => b.kind)).toEqual(['text'])

    const between = setup()
    between.compactions.compacting({ at: 3 })
    expect(between.entries).toHaveLength(1)
    between.compactions.uncompact(true)
    expect(between.entries).toEqual([])
  })

  it('forgets what it saw when another session is shown', () => {
    const { compactions } = setup()

    compactions.compacting({ at: 1_000 })
    compactions.compacted(2_000)
    compactions.forget()

    expect(compactions.unsummarized).toBe(false)
    expect(compactions.restore([{ at: 2_000, summary: 's' }])).toEqual([{ at: 2_000, compaction: { startedAt: 2_000, status: 'done', summary: 's' } }])
  })
})
