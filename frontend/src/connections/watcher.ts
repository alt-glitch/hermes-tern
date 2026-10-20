// The connect cards in the transcript, kept current: a `manage_connections` call's card follows
// the file the plugin's watcher writes (links and states), and the agent is told once every app
// of a card is connected, as the desktop's card settles the call. The card's own buttons land
// here too: Continue tells the agent which apps the user authorized, and Authorize opens an
// app's link. The card files are connections.ts's; this module only reads and claims them.

import { allConnected, CONNECT_TOOL, connectedMessage, continueMessage, loadConnect, mayTell, POLL_MS, waiting } from '../connections.js'
import { Poller } from '../core/poller.js'
import type { Transcript } from '../transcript.js'

/**
 * How long a connect call that drew no card (a status read, a call with nothing to authorize) is
 * not read again. Its card may still land (a write the pane read half of): it is read once more after.
 */
export const NO_CARD_MS = 30_000

/** What the connect watcher reaches of the app. */
export interface WatcherHost {
  readonly transcript: Pick<Transcript, 'calls' | 'mutateCall'>
  /** Asks for a render. */
  changed(): void
  /** Sends `text` to the agent as a message the app writes: it waits behind a running turn. */
  tell(text: string): void
  /** Opens `url` in the browser. */
  openUrl(url: string): void
}

/** Follows the open connect cards; one owner for the poll. */
export class ConnectWatcher {
  readonly #host: WatcherHost
  /** Where the card files are; unset: the plugin's data folder, read at each poll. */
  readonly #dir: string | undefined
  /** The poll: every POLL_MS while some card is watched. */
  readonly #poller: Poller = new Poller({ cadence: () => (this.#open ? POLL_MS : 'off'), run: async () => this.#tick() })
  /** Some card's apps still move (the last read found one watched and not settled). */
  #open = false
  /** Connect cards (by file) this pane saw with an app still waiting. */
  readonly #seen = new Set<string>()
  /** Connect calls that drew no card, and when: not read again for NO_CARD_MS. */
  readonly #noCard = new WeakMap<object, number>()

  /** `dir`: the plugin's data folder the card files are under (tests point it at their own). */
  constructor(host: WatcherHost, { dir }: { dir?: string } = {}) {
    this.#host = host
    this.#dir = dir
  }

  /**
   * Reads every connect card now (a new call or a reloaded transcript does not wait for the next
   * poll), then polls while some card is watched: a settled card never moves again.
   */
  watch() {
    this.#poller.poke()
  }

  /** A connect card's Continue: tell the agent which apps the user authorized, as the tool asks. */
  continue(ref: string) {
    const call = this.#call(ref)
    const card = call?.connect

    if (!call || !card || card.told || card.settled) {
      return
    }

    // As on the desktop, Continue settles the card: an app still waiting did not connect.
    this.#host.transcript.mutateCall(call, () => {
      card.told = true
      card.settled = 'continued'
    })

    // Another pane's message already told the agent.
    if (mayTell(card, this.#dir)) {
      this.#host.tell(continueMessage(card.targets))
    }

    this.#host.changed()
  }

  /** A connect card's Authorize: the app's link in the browser, and its row waits on the browser now. */
  open(ref: string, name: string) {
    const call = this.#call(ref)
    const card = call?.connect
    const target = card?.targets.find(t => t.name === name)

    if (!call || !card || !target?.url) {
      return
    }

    this.#host.openUrl(target.url)
    this.#host.transcript.mutateCall(call, () => (card.opened = [...new Set([...card.opened, name])]))
    this.#host.changed()
  }

  /** Stops the poll for good. */
  dispose() {
    this.#poller.dispose()
  }

  #tick() {
    let open = false
    const now = Date.now()

    for (const call of this.#host.transcript.calls(CONNECT_TOOL)) {
      const missed = this.#noCard.get(call)

      // A running call has no card yet; by its call id alone it would take an earlier call's.
      if (call.connect?.settled || call.outcome.kind === 'running' || (missed !== undefined && now - missed < NO_CARD_MS)) {
        continue
      }

      const next = loadConnect(call, this.#dir)

      if (!next) {
        this.#noCard.set(call, now)
        continue
      }

      this.#noCard.delete(call)

      if (JSON.stringify(next) !== JSON.stringify(call.connect)) {
        this.#host.transcript.mutateCall(call, c => (c.connect = next))
        this.#host.changed()
      }

      const seen = next.key ?? call.id

      if (next.targets.some(waiting) && !next.settled) {
        this.#seen.add(seen)
      }

      // Only a card this pane saw waiting: a resumed session's long-settled card stays quiet. Only
      // one pane tells: the claim is the card's.
      if (!next.told && this.#seen.has(seen) && allConnected(next) && mayTell(next, this.#dir)) {
        this.#host.transcript.mutateCall(call, () => (next.told = true))
        this.#host.tell(connectedMessage(next.targets))
        this.#host.changed()
      } else if (next.key && !next.settled) {
        open = true
      }
    }

    this.#open = open
  }

  /** The connect card `ref` names (its file, or its call id when it has none). */
  #call(ref: string) {
    return this.#host.transcript.calls(CONNECT_TOOL).findLast(c => (c.connect?.key ?? c.id) === ref)
  }
}
