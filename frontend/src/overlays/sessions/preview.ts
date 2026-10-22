// The session picker's preview loader: the selected session's first prompt, last reply and the
// first page of its transcript, read once the selection rests (arrowing through the list reads
// nothing), kept per session while the picker is open, and the next page read on request (the
// preview reaching the end of what it holds). One read of a session runs at a time.

import { errorText } from '../../core/errors.js'
import type { PreviewRow, SessionEnds, TranscriptReader } from '../../hermes/sessionTranscript.js'

/** One session's preview as loaded so far. */
export interface Preview {
  status: 'error' | 'loading' | 'ready'
  ends?: SessionEnds | undefined
  rows: PreviewRow[]
  /** The cursor of the next page; null at the end, or before the first page. */
  next: number | null
  loadingMore: boolean
  /** Why the first page failed (status 'error'), or the last page after it. */
  error?: string | undefined
}

interface Entry extends Preview {
  /** The keys of the rows kept, so a row a compaction copied forward shows once. */
  seen: Set<string>
}

export interface PreviewOptions {
  /** How long the selection rests before its preview loads, ms. */
  delay?: number
  /** Stored rows per page. */
  pageSize?: number
}

/** Pages read in a row when one adds no line (a page of tool results only). */
const EMPTY_PAGES = 5

export class PreviewLoader {
  readonly #reader: TranscriptReader
  readonly #changed: () => void
  readonly #delay: number
  readonly #pageSize: number
  readonly #cache = new Map<string, Entry>()
  #timer: ReturnType<typeof setTimeout> | undefined
  #disposed = false

  constructor(reader: TranscriptReader, changed: () => void, { delay = 200, pageSize = 40 }: PreviewOptions = {}) {
    this.#reader = reader
    this.#changed = changed
    this.#delay = delay
    this.#pageSize = pageSize
  }

  /** The selection moved to `id`: its preview loads once the selection rests `delay` ms, unless it is held. */
  select(id: string | undefined) {
    clearTimeout(this.#timer)
    this.#timer = undefined

    if (id === undefined || this.#disposed) {
      return
    }

    const held = this.#cache.get(id)

    if (held && held.status !== 'error') {
      return
    }

    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.#first(id)
    }, this.#delay)
  }

  /** Session `id`'s preview; undefined until its read starts. */
  get(id: string): Preview | undefined {
    return this.#cache.get(id)
  }

  /** Reads `id`'s next page; a no-op at the end, before the first page, or while a page is on its way. */
  more(id: string) {
    const entry = this.#cache.get(id)

    if (entry?.status === 'ready' && entry.next !== null && !entry.loadingMore) {
      void this.#more(id, entry)
    }
  }

  /** Drops what is held of `id` (a deleted session). */
  forget(id: string) {
    this.#cache.delete(id)
  }

  /** The picker closed: no timer left, and reads still on their way change nothing. */
  dispose() {
    clearTimeout(this.#timer)
    this.#disposed = true
    this.#cache.clear()
  }

  async #first(id: string) {
    const entry: Entry = { loadingMore: false, next: null, rows: [], seen: new Set(), status: 'loading' }
    this.#cache.set(id, entry)
    this.#changed()

    try {
      const [ends, page] = await Promise.all([this.#reader.ends(id), this.#reader.page(id, 0, this.#pageSize)])

      entry.ends = ends
      entry.status = 'ready'
      entry.next = page.next
      this.#keep(entry, page.rows)
    } catch (error) {
      entry.status = 'error'
      entry.error = errorText(error)
    }

    this.#done(id, entry)
  }

  async #more(id: string, entry: Entry) {
    entry.loadingMore = true
    entry.error = undefined
    this.#changed()

    try {
      for (let i = 0; i < EMPTY_PAGES && entry.next !== null; i++) {
        const page = await this.#reader.page(id, entry.next, this.#pageSize)

        entry.next = page.next

        if (this.#keep(entry, page.rows)) {
          break
        }
      }
    } catch (error) {
      entry.error = errorText(error)
    }

    entry.loadingMore = false
    this.#done(id, entry)
  }

  /** Appends the rows not seen yet; how many it kept. */
  #keep(entry: Entry, rows: readonly PreviewRow[]): number {
    const fresh = rows.filter(r => !entry.seen.has(r.key))

    for (const r of fresh) {
      entry.seen.add(r.key)
    }

    entry.rows.push(...fresh)

    return fresh.length
  }

  #done(id: string, entry: Entry) {
    // A read that outlived the picker, or a deleted session, draws nothing.
    if (!this.#disposed && this.#cache.get(id) === entry) {
      this.#changed()
    }
  }
}
