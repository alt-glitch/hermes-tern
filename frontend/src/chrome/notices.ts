// The gateway's keyed `notification.show` notices (credits, a slow start) on the status strip.
// Mirrors Hermes' ui-tui/src/app/createGatewayEventHandler.ts (notification.show/clear) and
// turnController's keyed notice. Notices is the list; NoticeStrip owns it with the timer that
// re-renders when a `ttl` one expires, so the strip drops it on time.

import type { NoticeEntry } from '../model.js'

/** A `notification.show` payload. */
export interface NoticePayload {
  text?: string
  level?: string
  kind?: string
  ttl_ms?: number | null
  key?: string | null
  id?: string | null
}

/** A notice on the status strip. */
export interface Notice {
  key: string
  text: string
  tone: NoticeEntry['tone']
  /** When a `ttl` notice goes (ms since the epoch). */
  expires?: number
}

const TONES: Record<string, NoticeEntry['tone']> = { error: 'error', success: 'success', warn: 'warning', warning: 'warning' }

/**
 * The session's out-of-band notices, by key: a show replaces the notice with its key, a clear
 * drops only its key (a late clear never wipes a newer notice), and a `ttl` one expires. The
 * newest live one is the one shown.
 */
export class Notices {
  #list: Notice[] = []
  #seq = 0

  /** Adds or replaces the notice; returns it (undefined for an empty one). */
  show(p: NoticePayload, now = Date.now()): Notice | undefined {
    const text = p.text?.trim()

    if (!text) {
      return undefined
    }

    const key = p.key || p.id || `n${++this.#seq}`
    const ttl = p.kind === 'ttl' && typeof p.ttl_ms === 'number' && p.ttl_ms > 0 ? p.ttl_ms : undefined
    const notice: Notice = { key, text, tone: TONES[p.level ?? ''] ?? 'info', ...(ttl ? { expires: now + ttl } : {}) }
    this.#list = [...this.#list.filter(n => n.key !== key), notice]

    return notice
  }

  /** Drops the notice with `key`; true when one went. */
  clear(key: string | undefined): boolean {
    const before = this.#list.length
    this.#list = this.#list.filter(n => n.key !== key)

    return this.#list.length !== before
  }

  /** The newest notice still live at `now`. */
  current(now = Date.now()): Notice | undefined {
    this.#list = this.#list.filter(n => !n.expires || n.expires > now)

    return this.#list.at(-1)
  }

  /** When the next `ttl` notice expires, if one is live. */
  nextExpiry(): number | undefined {
    const at = this.#list.flatMap(n => (n.expires ? [n.expires] : []))

    return at.length ? Math.min(...at) : undefined
  }

  /** Forgets every notice (another session is shown). */
  reset() {
    this.#list = []
  }
}

/** A `/login` step (its link, code or result): read and clicked in the transcript, not on the strip. */
export function isLoginNotice(p: NoticePayload): boolean {
  return Boolean(p.key?.startsWith('login:'))
}

/** What the strip reaches of the app. */
export interface NoticeStripHost {
  /** Asks for a render. */
  changed(): void
}

/** The status strip's notices, and the timer that re-renders when the next `ttl` one expires. */
export class NoticeStrip {
  readonly #host: NoticeStripHost
  readonly #notices = new Notices()
  #timer: NodeJS.Timeout | undefined

  constructor(host: NoticeStripHost) {
    this.#host = host
  }

  /** Adds or replaces the notice, and re-arms the expiry render. */
  show(p: NoticePayload) {
    this.#notices.show(p)
    this.#arm()
  }

  /** Drops the notice with `key`. */
  clear(key: string | undefined) {
    this.#notices.clear(key)
  }

  /** The notice the strip shows at `now`. */
  current(now = Date.now()): Notice | undefined {
    return this.#notices.current(now)
  }

  /** Forgets every notice (another session is shown). */
  reset() {
    this.#notices.reset()
  }

  /** Stops the expiry render. */
  dispose() {
    clearTimeout(this.#timer)
  }

  /** Re-renders when the next `ttl` notice expires, so the strip drops it on time. */
  #arm() {
    clearTimeout(this.#timer)
    const at = this.#notices.nextExpiry()

    if (at !== undefined) {
      this.#timer = setTimeout(() => {
        this.#notices.current()
        this.#arm()
        this.#host.changed()
      }, Math.max(0, at - Date.now()) + 10)
    }
  }
}
