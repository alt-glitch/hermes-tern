// The connect cards in the transcript, kept current: a `manage_connections` call's card follows
// the file the plugin's watcher writes (links and states), and the agent is told once every app
// of a card is connected, as the desktop's card settles the call. The card's own buttons land
// here too: Continue tells the agent which apps the user authorized, and Authorize opens an
// app's link. The card files are connections.ts's; this module only reads and claims them.

import { allConnected, claimTold, CONNECT_TOOL, connectedMessage, continueMessage, loadConnect, POLL_MS, waiting } from '../connections.js'
import type { Transcript } from '../transcript.js'

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

/** Follows the open connect cards; one owner for the poll's timer. */
export class ConnectWatcher {
  readonly #host: WatcherHost
  /** Where the card files are; unset: the plugin's data folder, read at each poll. */
  readonly #dir: string | undefined
  #timer: NodeJS.Timeout | undefined
  /** Connect cards (by file) this pane saw with an app still waiting. */
  readonly #seen = new Set<string>()
  /** Connect calls that drew no card (a status read, a call with nothing to authorize): never again. */
  readonly #noCard = new WeakSet<object>()

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
    clearTimeout(this.#timer)
    this.#tick()
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
    if (!card.key || claimTold(card.key, this.#dir)) {
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

  /** Stops the poll. */
  dispose() {
    clearTimeout(this.#timer)
  }

  #tick() {
    this.#timer = undefined
    let open = false

    for (const call of this.#host.transcript.calls(CONNECT_TOOL)) {
      // A running call has no card yet; by its call id alone it would take an earlier call's.
      if (call.connect?.settled || call.status === 'running' || this.#noCard.has(call)) {
        continue
      }

      const next = loadConnect(call, this.#dir)

      if (!next) {
        this.#noCard.add(call)
        continue
      }

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
      if (!next.told && this.#seen.has(seen) && allConnected(next) && (!next.key || claimTold(next.key, this.#dir))) {
        this.#host.transcript.mutateCall(call, () => (next.told = true))
        this.#host.tell(connectedMessage(next.targets))
        this.#host.changed()
      } else if (next.key && !next.settled) {
        open = true
      }
    }

    if (open) {
      this.#timer = setTimeout(() => this.#tick(), POLL_MS)
    }
  }

  /** The connect card `ref` names (its file, or its call id when it has none). */
  #call(ref: string) {
    return this.#host.transcript.calls(CONNECT_TOOL).findLast(c => (c.connect?.key ?? c.id) === ref)
  }
}
