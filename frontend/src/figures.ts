// Figures in a finished reply that Tern draws from a fence: ```mermaid through merman, ```svg as a
// picture. A diagram merman cannot parse shows as its source in an empty frame, so after a turn the
// app has the plugin's Python half check them (figure_check.py, over plugin RPC) and asks the agent
// once to send the broken ones again. Hermes has no hook to keep a turn going after a text-only
// answer (pre_verify fires only after file edits), so the ask is a prompt of its own.

import { createHash } from 'node:crypto'

import type { MessageCompletePayload } from '@hermes/shared/gateway-events'

import { record } from './wire/json.js'

export type FigureLang = 'mermaid' | 'svg'

/** A figure fence: its language, source, and its number among the reply's figures of that language. */
export interface Figure {
  lang: FigureLang
  source: string
  n: number
}

export interface FigureFailure extends Figure {
  error: string
  /** The line in the figure's source, when the checker knows it. */
  line?: number | undefined
}

/**
 * Checks the figures of session `sid`'s reply `text`: the ones that would not render, or undefined
 * when they cannot be checked or another pane showing the session claimed the reply.
 */
export type FigureCheck = (sid: string, text: string, figures: readonly Figure[]) => Promise<FigureFailure[] | undefined>

const OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/
// A first check downloads merman through uv.
const CHECK_TIMEOUT_MS = 150_000

/** The reply's ```mermaid and ```svg fences, outside any other fence; a fence left open is no figure. */
export function figures(text: string): Figure[] {
  const out: Figure[] = []
  const counts: Record<FigureLang, number> = { mermaid: 0, svg: 0 }
  let open: { mark: string; lang: string; lines: string[] } | undefined

  for (const line of text.split('\n')) {
    if (open) {
      const close = line.trim()

      if (close.length >= open.mark.length && close === open.mark.charAt(0).repeat(close.length)) {
        if (open.lang === 'mermaid' || open.lang === 'svg') {
          out.push({ lang: open.lang, n: ++counts[open.lang], source: open.lines.join('\n') })
        }

        open = undefined
      } else {
        open.lines.push(line)
      }

      continue
    }

    const m = OPEN.exec(line)

    if (m?.[1]) {
      open = { lang: (m[2] ?? '').toLowerCase(), lines: [], mark: m[1] }
    }
  }

  return out
}

const NAME: Record<FigureLang, string> = { mermaid: 'Mermaid diagram', svg: 'SVG figure' }

/** The prompt that asks for the broken figures again. */
export function fixPrompt(failed: readonly FigureFailure[]): string {
  const lines = failed.map(f => `- ${NAME[f.lang]} ${f.n}${f.line ? `, line ${f.line}` : ''}: ${f.error}`)
  const one = failed.length === 1

  return [
    `${one ? 'A figure' : 'Some figures'} in your last reply ${one ? 'does' : 'do'} not render in Tern:`,
    '',
    ...lines,
    '',
    `Send ${one ? 'it' : 'them'} again, fixed, each in its fence, with no other text.`
  ].join('\n')
}

/** The plugin RPC method that starts a check, and the session event that answers it (figure_check.py). */
export const CHECK_METHOD = 'plugin.hermes-tern.figures.check'
export const CHECKED_EVENT = 'plugin.hermes-tern.figures.checked'

/** What the check reaches of the gateway client: its requests, and its events for the result. */
export interface FigureGateway {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: 'event', listener: (ev: { type: string; payload?: unknown }) => void): unknown
}

/** The failed figures of a `figures.checked` payload; undefined when it holds no result per figure. */
export function checkedFailures(figs: readonly Figure[], payload: unknown): FigureFailure[] | undefined {
  const results = record(payload)?.['results']

  if (!Array.isArray(results) || results.length !== figs.length) {
    return undefined
  }

  return figs.flatMap((f, i) => {
    const r = record(results[i])

    if (r?.['ok'] !== false) {
      return []
    }

    const error = r['error']
    const line = r['line']

    return [{ ...f, error: (typeof error === 'string' && error) || 'it does not parse', line: typeof line === 'number' ? line : undefined }]
  })
}

/**
 * A {@link FigureCheck} that asks the plugin's Python half over `gw`. The call answers at once
 * whether this pane claimed the reply (one pane per reply asks the agent); the result arrives as
 * the `plugin.hermes-tern.figures.checked` event, keyed by the reply's hash.
 */
export function gatewayFigureCheck(gw: FigureGateway): FigureCheck {
  const waiting = new Map<string, (payload: unknown) => void>()

  gw.on('event', ev => {
    const reply = ev.type === CHECKED_EVENT ? record(ev.payload)?.['reply'] : undefined

    if (typeof reply === 'string') {
      waiting.get(reply)?.(ev.payload)
    }
  })

  return async (sid, text, figs) => {
    const reply = createHash('sha256').update(`${sid}\0${text}`).digest('hex').slice(0, 32)
    // Waiting starts before the call: the result can arrive before the call's answer.
    const result = new Promise<unknown>(resolve => {
      const finish = (payload: unknown) => {
        clearTimeout(timer)
        waiting.delete(reply)
        resolve(payload)
      }
      const timer = setTimeout(() => finish(undefined), CHECK_TIMEOUT_MS)

      waiting.set(reply, finish)
    })

    const claimed = await gw
      .request(CHECK_METHOD, { figures: figs.map(f => ({ lang: f.lang, source: f.source })), reply, session_id: sid })
      .then(r => record(r)?.['claimed'] === true)
      // A gateway without the plugin's method, or a session that went: nothing to check.
      .catch(() => false)

    if (!claimed) {
      waiting.get(reply)?.(undefined)

      return undefined
    }

    return checkedFailures(figs, await result)
  }
}

/** Asks the agent to resend the figures of a finished reply that would not render, once per user prompt. */
export class FigureAsk {
  readonly #check: FigureCheck
  readonly #live: () => null | string
  readonly #send: (prompt: string) => void
  /** The agent was asked since the user's last prompt. */
  #asked = false

  constructor(check: FigureCheck, live: () => null | string, send: (prompt: string) => void) {
    this.#check = check
    this.#live = live
    this.#send = send
  }

  /** The user sent a prompt: its reply may be asked about again. */
  reset() {
    this.#asked = false
  }

  /** Checks a finished reply's figures; when one would not render, sends the prompt that asks for it again. */
  afterReply(payload: Pick<MessageCompletePayload, 'status' | 'text'>) {
    const text = payload.status === 'complete' && typeof payload.text === 'string' ? payload.text : undefined
    const sid = this.#live()
    const figs = text && !this.#asked ? figures(text) : []

    if (!text || !sid || !figs.length) {
      return
    }

    void this.#check(sid, text, figs).then(failed => {
      if (!failed?.length || this.#live() !== sid || this.#asked) {
        return
      }

      this.#asked = true
      this.#send(fixPrompt(failed))
    })
  }
}
