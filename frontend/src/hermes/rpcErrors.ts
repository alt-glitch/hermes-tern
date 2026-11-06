// A gateway error in words, and what a refused slash command leads to. Tern's own copy of the
// rules Hermes' Ink TUI applies (ui-tui/src/app/userMessages.ts), which is not a public module:
// the error codes and texts are the gateway's wire contract.

/** JSON-RPC error codes the gateway answers with. */
const RPC_INVALID_PARAMS = 4000
const RPC_SESSION_NOT_FOUND = 4001
const RPC_NOT_DISPATCHABLE = 4018
const RPC_UNKNOWN_METHOD = -32601

const DETAIL_LIMIT = 300

/** An error's JSON-RPC `code`, `message` and `data`, where it has them. */
function shape(error: unknown): { code?: number; message?: string; data?: { reason?: unknown; detail?: unknown } } {
  if (!(error instanceof Error)) {
    return {}
  }

  const code = 'code' in error && typeof error.code === 'number' ? error.code : undefined
  const data = 'data' in error && typeof error.data === 'object' && error.data !== null ? error.data : undefined

  return {
    ...(code === undefined ? {} : { code }),
    ...(data ? { data: { detail: 'detail' in data ? data.detail : undefined, reason: 'reason' in data ? data.reason : undefined } } : {}),
    message: error.message
  }
}

function detailLine(raw: string): string | null {
  const text = raw.replace(/\s+/g, ' ').trim()

  return text ? `Details: ${text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT - 1)}…` : text}` : null
}

const VERSION_SKEW_RE = /Extra inputs are not permitted|^unknown method:/
// Both server routes' answer for a method they do not serve. A JSON-RPC client sends no version,
// so this is not proof of skew.
const UNAVAILABLE_METHOD_RE = /^unknown method: (\S+) — not available on this Hermes backend$/

/** The frontend and the gateway disagree on the wire: an older or newer Hermes. */
function isVersionSkew(code: number | undefined, message: string): boolean {
  if (UNAVAILABLE_METHOD_RE.test(message)) {
    return false
  }

  return (
    code === RPC_UNKNOWN_METHOD ||
    (code === RPC_INVALID_PARAMS && VERSION_SKEW_RE.test(message)) ||
    (code === undefined && VERSION_SKEW_RE.test(message))
  )
}

// Ordered: the first match wins. 4001 also carries unrelated refusals, so only the text says
// "session not found".
const ROWS: [match: (code: number | undefined, text: string) => RegExpExecArray | boolean | null, say: (m: RegExpExecArray | null) => string][] = [
  [
    (code, text) => (code === RPC_SESSION_NOT_FOUND || code === undefined) && /session not found/i.test(text),
    () => 'This chat is no longer attached to the backend (it was idle or the backend restarted). Your history is saved: type /resume to reopen it.'
  ],
  [
    (_code, text) => text === 'session_read_only',
    () => 'This chat is stored history Hermes can show but not continue, so your message was not run. Use /new to start a new chat.'
  ],
  [
    (_code, text) => text === 'session_has_children',
    () => 'This chat has child sessions (such as subagent runs) that deleting it would remove too, so it was not deleted.'
  ],
  [
    (_code, text) => /^gateway not (?:connected|running)\b/.test(text),
    () => 'Hermes is not connected right now, so that was not sent. It reconnects automatically; wait a moment and try again.'
  ],
  [(_code, text) => UNAVAILABLE_METHOD_RE.exec(text), m => `This Hermes backend does not provide ${m?.[1] ?? '?'}, so that was not done.`],
  [
    (_code, text) => text.trim() === 'launch_credentials_unavailable',
    () =>
      "This chat can't use the API key it was started with any more (it changed or was removed), so that was not done. A chat never switches to a different key on its own. Type /new to start a new chat on your current key."
  ],
  [
    (_code, text) => /^request timed out after (\d+)s/.exec(text),
    m => `Hermes did not answer within ${m?.[1] ?? '?'}s. Try again; if it keeps happening, report the last lines of the gateway log.`
  ]
]

/** A transport or session error in plain words; any other error's own text. */
export function describeRpcError(error: unknown): string {
  const { code, message } = shape(error)
  const text = message ?? (typeof error === 'string' && error.trim() ? error : 'request failed')

  if (isVersionSkew(code, text)) {
    return 'Tern and the Hermes backend are out of sync (different versions). Run `hermes update`, then start `hermes tern` again.'
  }

  for (const [match, say] of ROWS) {
    const m = match(code, text)

    if (m) {
      return say(m === true ? null : m)
    }
  }

  return text
}

/** The shared gateway's slash.exec refuses a command outside its reviewed reads with `unsupported_command`. */
export function isUnsupportedCommand(error: unknown): boolean {
  return shape(error).data?.reason === 'unsupported_command'
}

/** Why `/command` failed in slash.exec or command.dispatch, naming the command rather than the helper. */
export function describeSlashExecError(command: string, error: unknown): string {
  const { data, message = '' } = shape(error)

  if (isUnsupportedCommand(error)) {
    // The gateway names what to use instead in `data.detail`.
    const refusal = `/${command} is not available on the shared gateway yet`

    return typeof data?.detail === 'string' && data.detail.trim() ? `${refusal}\n${data.detail.trim()}` : refusal
  }

  if (/slash worker timed out/.test(message)) {
    return `/${command} did not finish: the command helper timed out. Try again.`
  }

  if (/slash worker (?:exited|closed pipe|start failed)/.test(message)) {
    const detail = detailLine(message.replace(/^slash worker (?:exited|closed pipe:?|start failed:?)\s*/, ''))

    return [`/${command} did not finish: the command helper crashed. Try again.`, detail].filter(Boolean).join('\n')
  }

  return describeRpcError(error)
}

// slash.exec answers 4018 with exactly these texts when it does not own the command. Every other
// 4018 came from a command.dispatch handler slash.exec already forwarded to (/retry, /undo,
// /compress, /queue, bundles): dispatching again would run a mutating command twice.
const NOT_MINE_RE = /^skill command: use command\.dispatch for \/|use command\.dispatch for \/snapshot restore/

/** Whether a slash.exec refusal falls through to command.dispatch: only "slash.exec does not own this command". */
export function shouldFallbackToDispatch(error: unknown): boolean {
  const { code, message = '' } = shape(error)

  if (code === RPC_NOT_DISPATCHABLE) {
    return NOT_MINE_RE.test(message)
  }

  // An older backend sends no code: keep falling through unless the text is a helper failure.
  return code === undefined && !/slash worker|timed out|not connected|not running/.test(message)
}
