// The session picker's lists, read from the gateway a page at a time (hermes/sessionList.ts). A
// tab's listing holds the live sessions and the stored pages read so far; a search's listing holds
// the stored pages whose titles or ids hold its text. A listing reads its next page only when the
// picker asks, so a store of tens of thousands of conversations is never read whole.

import type { Requester } from '../../wire/rpc.js'
import { liveSessions, type ListedSession, type SessionFilter, storedPage } from '../../hermes/sessionList.js'

/** How long the search text rests before the gateway is asked. */
export const SEARCH_PAUSE = 250
/** The longest text the gateway searches for. */
const QUERY_MAX = 200

/** What a listing reads with and reports to. */
export interface ListingPorts {
  gw: Requester
  /** Whether a row is shown at all. */
  keep: (s: ListedSession) => boolean
  /** Called when rows came in. */
  changed: () => void
}

/** One list of the picker, read a page at a time. */
export class Listing {
  /** The rows read so far, once each, newest activity first. */
  rows: ListedSession[] = []
  /** A page is being read. */
  loading = false
  /** The next page's cursor; undefined before the first page, null once the store has no more. */
  #next: string | null | undefined
  /** The ids and conversation ids of every row read, kept rows or not. */
  readonly #seen = new Set<string>()
  #closed = false

  /** `live`: the first read also takes the sessions the gateway serves now, in the same folder. */
  constructor(
    private readonly ports: ListingPorts,
    private readonly filter: SessionFilter,
    private readonly live: boolean
  ) {}

  /** The store holds no rows this listing has not read. */
  get exhausted(): boolean {
    return this.#next === null
  }

  /**
   * Reads the next page (the first one on the first call). Does nothing while a page is being read,
   * once the store has no more, or after `close`. Rejects with the gateway's refusal; the rows read
   * so far stay, and the next call tries the same page again.
   */
  async read(): Promise<void> {
    const cursor = this.#next

    if (this.loading || cursor === null || this.#closed) {
      return
    }

    this.loading = true

    try {
      const [live, page] = await Promise.all([
        this.live && cursor === undefined ? liveSessions(this.ports.gw, this.filter.workspace) : [],
        storedPage(this.ports.gw, this.filter, cursor)
      ])

      if (this.#closed) {
        return
      }

      // A live row comes first: only it says whether the session runs.
      this.#add([...live, ...page.rows])
      this.#next = page.next
      this.ports.changed()
    } finally {
      this.loading = false
    }
  }

  /** Forgets row `id` (deleted); a later page that repeats it does not bring it back. */
  drop(id: string) {
    this.rows = this.rows.filter(s => s.id !== id)
  }

  /** Drops every reply still to come. */
  close() {
    this.#closed = true
  }

  #add(rows: ListedSession[]) {
    // A row a later page repeats (the store changed between pages) replaces nothing.
    for (const s of rows) {
      if (!this.#seen.has(s.conversation) && !this.#seen.has(s.id)) {
        this.#seen.add(s.conversation).add(s.id)

        if (this.ports.keep(s)) {
          this.rows.push(s)
        }
      }
    }

    this.rows.sort((a, b) => b.lastActive - a.lastActive)
  }
}

/** The gateway's search for the picker's text: asked once the text rests, replaced when the text or the folder changes. */
export class StoredSearch {
  #listing: Listing | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #asked = ''

  /** `failed`: a page the gateway refused. */
  constructor(
    private readonly ports: ListingPorts,
    private readonly failed: (error: unknown) => void
  ) {}

  /** The listing for the current text, once it is asked for. */
  get listing(): Listing | undefined {
    return this.#listing
  }

  /** Searches every stored title and id for `text`, in `workspace` when one is named; '' stops. Repeating the last call does nothing. */
  set(text: string, workspace: string | undefined) {
    const query = text.trim()
    const asked = `${workspace ?? ''}\n${query}`

    if (asked === this.#asked) {
      return
    }

    this.#asked = asked
    this.dispose()

    if (query && query.length <= QUERY_MAX) {
      this.#timer = setTimeout(() => {
        this.#listing = new Listing(this.ports, { query, workspace }, false)
        this.#listing.read().catch(this.failed)
      }, SEARCH_PAUSE)
    }
  }

  /** Stops the search: a pending ask is not sent, and a reply still to come is dropped. */
  dispose() {
    clearTimeout(this.#timer)
    this.#listing?.close()
    this.#listing = undefined
  }
}
