// What the shared gateway says about a turn outside its stream: `status.update` lines (lifecycle,
// warnings, compaction, goal verdicts) and keyed `notification.show` notices (credits, /login).
// Mirrors Hermes' ui-tui/src/app/createGatewayEventHandler.ts (status.update, notification.show/clear)
// and turnController's keyed notice.

import { lineTokens } from './compaction.js'
import type { NoticeEntry } from './model.js'

/** The working line while the context is compacted; the stream's own labels wait for the done edge. */
export const COMPACTING_LABEL = 'Compressing context…'

/** What one `status.update` does to the view. */
export interface StatusEffect {
  /** The working line's label (only while a turn runs). */
  label?: string
  /** A line for the transcript. */
  notice?: { text: string; tone: NoticeEntry['tone'] }
  /** Compaction started (true) or ended (false): the transcript's compaction rule shows it. */
  compacting?: boolean
  /** The token counts the compaction line gave. */
  tokens?: { before?: number; after?: number }
  /** The warning to pass back as `last` next time. */
  note?: string
}

/**
 * The effect of `status.update {kind, text}`. The shared gateway sends `lifecycle` (retries,
 * fallbacks), `warn`, `compacting`/`compacted` (auto-compaction) and `goal`; `last` is the warning
 * shown last, so a repeated one stays a single line.
 */
export function statusEffect(payload: { kind?: string; text?: string } | undefined, last?: string): StatusEffect {
  const text = payload?.text?.trim()
  const kind = payload?.kind ?? ''

  // /compress always ends with a bare `ready` (methods_session._compress_live's finally).
  if (!text) {
    return kind === 'ready' ? { compacting: false } : {}
  }

  if (kind === 'goal') {
    return { notice: { text, tone: text.startsWith('✓') ? 'success' : 'info' } }
  }

  if (kind === 'compacting' || kind === 'compressing') {
    return { compacting: true, label: COMPACTING_LABEL, ...counted(text) }
  }

  if (kind === 'compacted' || kind === 'ready') {
    return { compacting: false, label: text, ...counted(text) }
  }

  if (kind === 'warn' || kind === 'approval' || kind === 'error') {
    return text === last ? {} : { note: text, notice: { text, tone: kind === 'error' ? 'error' : 'warning' } }
  }

  return { label: text }
}

/** A compaction line's token counts, when it gives any. */
function counted(text: string): Pick<StatusEffect, 'tokens'> {
  const tokens = lineTokens(text)

  return tokens.before || tokens.after ? { tokens } : {}
}

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
