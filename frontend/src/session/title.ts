// The session's name, on the status strip and on Tern's tab: OSC 2 names the pane, and the tab
// follows it (the surface's own `hermes` title stands only until a program sets one). It comes
// with session.info and session.title, from the session list when only that changed, and from
// `/new <title>`'s rename.

import type { GatewayClient } from '@tui/gatewayClient.js'

import type { ChatPorts } from '../app/ports.js'
import { errorText } from '../core/errors.js'
import type { LiveSessionId } from '../core/ids.js'
import { mutateSession } from '../hermes/mutate.js'
import { setTabTitle } from '../surface/osc.js'
import { rpc } from '../wire/rpc.js'

/** How long after a session-list change the title is read from it. */
const READ_MS = 400

/** What the title reaches of the app. */
export type TitleHost = Pick<ChatPorts, 'changed' | 'notice' | 'session'> & {
  readonly gw: Pick<GatewayClient, 'isCanonical' | 'request'>
}

/** The open session's title, as Hermes names it (`session.title`). */
export class SessionTitle {
  readonly #host: TitleHost
  #text = ''
  #timer: NodeJS.Timeout | undefined

  constructor(host: TitleHost) {
    this.#host = host
  }

  /** The title; '' while the session has none. */
  get text(): string {
    return this.#text
  }

  /** Names the session `title` (trimmed) on the strip and the tab; true when it changed. */
  set(title: string | undefined): boolean {
    const next = title?.trim()

    if (!next || next === this.#text) {
      return false
    }

    this.#text = next
    setTabTitle(next)

    return true
  }

  /** Another session is shown: its own name (or none yet) on the tab, and a read of the list. */
  adopt(title: string | undefined) {
    this.#text = ''
    this.set(title)
    this.read()
  }

  /**
   * Reads the session's title from the session list, a moment after the list changed: the shared
   * gateway tells viewers only that (`sessions.changed`) when /title or the auto-titler names it,
   * and serves no `session.title`. The session is among the newest rows; its stored id finds it.
   */
  read() {
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => void this.#fetch(), READ_MS)
  }

  /** Names session `sid` (`/new <title>`): the shared gateway's rename mutation, a private one's `session.title`. */
  async rename(sid: LiveSessionId, title: string) {
    const host = this.#host

    try {
      const r = host.gw.isCanonical
        ? await mutateSession(host.gw, sid, 'rename', { title })
        : await rpc(host.gw, 'session.title', { session_id: sid, title })

      if (sid === host.session.ref.live && this.set(String(r?.title ?? title))) {
        host.changed()
      }
    } catch (error) {
      host.notice(`Could not name the session: ${errorText(error)}`, 'warning')
    }
  }

  /** Stops a pending list read. */
  dispose() {
    clearTimeout(this.#timer)
  }

  async #fetch() {
    const { live: sid, stored } = this.#host.session.ref
    const ids = new Set<string | null>([sid, stored].filter(Boolean))

    if (!sid) {
      return
    }

    try {
      const r = await rpc(this.#host.gw, 'session.list', { limit: 20 })
      const row = r?.sessions?.find(x => ids.has(x.id ?? '') || ids.has(x.resolved_id ?? ''))

      if (sid === this.#host.session.ref.live && this.set(row?.title)) {
        this.#host.changed()
      }
    } catch {
      // No session list: the title still arrives with session.info.
    }
  }
}
