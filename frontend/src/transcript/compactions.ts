// The compactions one view saw happen, and where each shows among the transcript's entries: a
// step of the running turn, or an entry between turns. The store's summaries reach them later,
// and a reload takes their numbers for the stored compactions they turn out to be.

import type { StoredCompaction } from '../compaction.js'
import type { EntryId } from '../core/ids.js'
import type { Compaction, CompactionEntry, Entry, TurnEntry } from '../model.js'

/** What Compactions reads and changes of the transcript that holds it. */
export interface CompactionHost {
  /** The transcript's entries, in place: a compaction goes in among them, an aborted one comes out. */
  entries(): Entry[]
  /** The streaming turn, if one is. */
  live(): TurnEntry | undefined
  /** A fresh id for an entry or block. */
  id(prefix: string): EntryId
}

/** A context compaction starting: its tokens before (when known), when, and whether /compress asked for it. */
export interface CompactionStart {
  before?: number | undefined
  /** When it started; now when not given. */
  at?: number
  manual?: boolean
}

/** A stored compaction, as a reload shows it. */
export interface RestoredCompaction {
  /** When its summary was written: where it goes among the stored messages. */
  at: number
  compaction: Compaction
}

/** The compactions this view saw happen: what a reload's stored ones get their numbers from. */
export class Compactions {
  readonly #host: CompactionHost
  #seen: Compaction[] = []

  constructor(host: CompactionHost) {
    this.#host = host
  }

  /**
   * The context started compacting. Inside a running turn that already did something it is a
   * step of that turn; else it goes between turns, before the turn it was compacted for. Hermes'
   * later lines of the same compaction only fill in the count. Returns the compaction (the one
   * already running, when it fills one in): the handle uncompact() takes back.
   */
  compacting({ before, at = Date.now(), manual = false }: CompactionStart): Compaction {
    const running = this.#seen.findLast(c => c.status === 'running')

    if (running) {
      running.before ??= before || undefined
      running.manual ||= manual || undefined
      this.#touch(running)

      return running
    }

    const compaction: Compaction = { startedAt: at, status: 'running', ...(before ? { before } : {}), ...(manual ? { manual } : {}) }
    this.#seen.push(compaction)
    const live = this.#host.live()

    if (live?.blocks.length) {
      live.blocks.push({ at, compaction, id: this.#host.id('z'), kind: 'compaction' })
      live.rev++

      return compaction
    }

    const entry: CompactionEntry = { compaction, id: this.#host.id('z'), kind: 'compaction', rev: 0 }
    const entries = this.#host.entries()

    if (live && entries.at(-1) === live) {
      entries.splice(-1, 0, entry)
    } else {
      entries.push(entry)
    }

    return compaction
  }

  /**
   * The running compaction ended. `tokens` are the owner's own counts (/compress reports them
   * after its `ready` edge, so they also reach the compaction that just ended).
   */
  compacted(at = Date.now(), tokens: { before?: number; after?: number } = {}) {
    const running = this.#seen.findLast(c => c.status === 'running')
    const c = running ?? (tokens.before || tokens.after ? this.#seen.at(-1) : undefined)

    if (!c) {
      return
    }

    if (running) {
      running.status = 'done'
      running.endedAt = at
    }

    c.before = tokens.before || c.before
    c.after = tokens.after || c.after
    this.#touch(c)
  }

  /**
   * A compaction did not happen after all. `'running'`: Hermes aborted the last one (no done edge
   * came before the turn ended), dropped only while it runs; a compaction: the one compacting()
   * returned to /compress, which changed nothing (another one seen since stays).
   */
  uncompact(which: Compaction | 'running') {
    const last = this.#seen.at(-1)
    const c = which === 'running' ? (last?.status === 'running' ? last : undefined) : which
    const seen = c ? this.#seen.indexOf(c) : -1

    if (!c || seen < 0) {
      return
    }

    this.#seen.splice(seen, 1)
    const entries = this.#host.entries()
    const at = entries.findIndex(e => e.kind === 'compaction' && e.compaction === c)

    if (at >= 0) {
      entries.splice(at, 1)

      return
    }

    const turn = entries.findLast(
      (e): e is TurnEntry => e.kind === 'turn' && e.blocks.some(b => b.kind === 'compaction' && b.compaction === c)
    )

    if (turn) {
      turn.blocks = turn.blocks.filter(b => b.kind !== 'compaction' || b.compaction !== c)
      turn.rev++
    }
  }

  /**
   * A context reading (tokens in use): the first one under the last compaction's `before` is what
   * it left. A reading from before it finished (a stale tick) is not lower, so it is skipped.
   */
  contextUsed(used: number) {
    const c = this.#seen.at(-1)

    if (c?.status !== 'done' || c.after !== undefined || !(used > 0) || (c.before && used >= c.before * 0.95)) {
      return
    }

    c.after = used
    this.#touch(c)
  }

  /** The compactions seen here that the store has no summary for yet. */
  get unsummarized(): boolean {
    return this.#seen.some(c => c.status === 'done' && c.summary === undefined)
  }

  /** Gives each seen compaction the stored summary written while it ran. */
  summarize(stored: readonly StoredCompaction[]) {
    for (const [mark, c] of this.#claims(stored)) {
      if (c.summary === undefined) {
        c.summary = mark.summary ?? ''
        c.messages = mark.messages
        this.#touch(c)
      }
    }
  }

  /**
   * The compactions a reload shows for `stored`, oldest first: the one this view saw happen when
   * there is one (its numbers stay, the store's summary fills in), else one from the store alone.
   */
  restore(stored: readonly StoredCompaction[]): RestoredCompaction[] {
    const marks = [...stored].sort((a, b) => a.at - b.at)
    const claims = this.#claims(marks)

    return marks.map(mark => ({ at: mark.at, compaction: restored(mark, claims.get(mark)) }))
  }

  /** Another session is shown: the compactions seen were the last one's. */
  forget() {
    this.#seen = []
  }

  /** Which stored compaction each seen one is: the nearest summary written while it ran, each once. */
  #claims(stored: readonly StoredCompaction[]): Map<StoredCompaction, Compaction> {
    const out = new Map<StoredCompaction, Compaction>()

    for (const c of this.#seen) {
      const end = c.endedAt ?? c.startedAt
      const mark = stored
        .filter(s => c.status === 'done' && !out.has(s) && within(c, s.at))
        .sort((a, b) => Math.abs(a.at - end) - Math.abs(b.at - end))[0]

      if (mark) {
        out.set(mark, c)
      }
    }

    return out
  }

  /** Marks the turn or entry showing `c` changed. */
  #touch(c: Compaction) {
    const shown = this.#host
      .entries()
      .findLast(e => (e.kind === 'compaction' && e.compaction === c) || (e.kind === 'turn' && e.blocks.some(b => b.kind === 'compaction' && b.compaction === c)))

    if (shown?.kind === 'compaction' || shown?.kind === 'turn') {
      shown.rev++
    }
  }
}

/** A stored compaction, as the one this view saw happen (`seen`) when there is one: its numbers stay. */
function restored(mark: StoredCompaction, seen: Compaction | undefined): Compaction {
  if (seen) {
    seen.summary = mark.summary ?? ''
    seen.messages = mark.messages

    return seen
  }

  return { startedAt: mark.at, status: 'done', ...(mark.summary ? { summary: mark.summary } : {}), ...(mark.messages ? { messages: mark.messages } : {}) }
}

/** A summary written at `at` belongs to compaction `c`: while it ran, give or take the clocks. */
function within(c: Compaction, at: number): boolean {
  return at >= c.startedAt - 5_000 && at <= (c.endedAt ?? Date.now()) + 15_000
}
