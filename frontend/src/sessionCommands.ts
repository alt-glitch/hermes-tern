// Session commands the shared gateway serves only through dedicated RPCs: its `slash.exec`
// refuses them by name. /undo, /retry, /compress and /branch are `session.mutate` operations
// (gateway/session_mutations.py); /save, /reload, /reload-skills and /rollback are their own
// verbs (gateway/session_tui_ops.py, session_tui_side.py,
// session_ancillary.py). Mirrors Hermes' ui-tui/src/app/slash/commands/{core,session,ops}.ts and
// canonicalSessionCommands.ts / canonicalSessionControls.ts.
import type { ControlHost } from './controlCommands.js'
import { type MutationResult, mutateSession } from './hermes/mutate.js'
import { lastTurnRewind, retryText, retryTurnRewind } from './hermes/rewind.js'

/** What a session command needs beyond a control command's host; App.control() supplies it. */
export interface SessionHost extends ControlHost {
  /** The gateway is Hermes' shared one (only it serves `session.mutate`). */
  canonical: boolean
  /** The view has moved off the session this host was made for. */
  stale(): boolean
  panel(title: string, text: string): void
  /** Re-reads the session's transcript from the gateway (after a rewind, compression or restore). */
  reload(): Promise<void>
  /** Sends `text` as a prompt now. */
  send(text: string): void
  /** Shows session `id` in this view; false when the view did not move to it. */
  open(id: string): Promise<boolean>
}

export interface SessionCommand {
  name: string
  aliases?: readonly string[]
  /** Returning false hands the command to `slash.exec` (a private gateway, which still serves it). */
  run(host: SessionHost, arg: string): Promise<boolean | void> | boolean | void
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** `/undo` and `/retry`: rewind to before the newest user turn; `/retry` then resends that turn's text. */
async function rewind(host: SessionHost, intent: 'retry' | 'undo') {
  if (!host.canonical) {
    return false
  }

  if (!host.sid) {
    return host.notice(`Nothing to ${intent}.`)
  }

  const result = await mutateSession(host.gw, host.sid, 'rewind', intent === 'retry' ? retryTurnRewind : lastTurnRewind)
  const removed = Number(result?.rewound_count ?? 0)

  if (host.stale()) {
    return
  }

  if (!result || removed <= 0) {
    return host.notice(`Nothing to ${intent}.`)
  }

  await host.reload()

  if (host.stale()) {
    return
  }

  if (intent === 'undo') {
    return host.notice(`Undid ${plural(removed, 'message')}.`)
  }

  // The rewound turn's own text, not whatever this view typed last.
  const text = retryText((result.target_message as { content?: unknown } | undefined)?.content)

  return text ? host.send(text) : host.notice('Nothing to retry.')
}

interface CompressSummary {
  headline?: string
  noop?: boolean
  note?: string
  token_line?: string
}

/** The owner's report (headline, token line, note), as the native /compress prints it. */
export function compressReport(summary: CompressSummary | null | undefined): string {
  const head = summary?.headline ? `${summary.noop ? '' : '✓ '}${summary.headline}` : '✓ Transcript compressed.'

  return [head, ...[summary?.token_line, summary?.note].filter(Boolean).map(line => `  ${line}`)].join('\n')
}

/** `/compress [here [N] | focus | --preview]`: the raw argument is the payload's `focus`, parsed by the owner. */
async function compress(host: SessionHost, arg: string) {
  if (!host.canonical) {
    return false
  }

  if (!host.sid) {
    return host.notice('No active session.', 'warning')
  }

  if (host.busy) {
    return host.notice('Wait for the current turn to finish (or press Esc twice) before compressing.', 'warning')
  }

  const focus = arg.trim()

  // The summary is an LLM call: say it started (a `--preview` only reads).
  if (!/(^|\s)--preview(\s|$)/.test(focus)) {
    host.notice('Compressing the conversation…')
  }

  const result: MutationResult = await mutateSession(host.gw, host.sid, 'compress', focus ? { focus } : {})

  if (host.stale()) {
    return
  }

  if (result.status === 'preview') {
    // `--preview` is a read-only report.
    return host.notice(Array.isArray(result.lines) ? result.lines.join('\n') : 'Nothing to preview.')
  }

  if (result.status !== 'noop') {
    // The compressed transcript replaces the shown one.
    await host.reload()

    if (host.stale()) {
      return
    }
  }

  host.notice(compressReport(result.summary as CompressSummary | undefined))
}

/** `/branch [title]`: a copy of the session the view then moves to (the original keeps its history). */
async function branch(host: SessionHost, arg: string) {
  if (!host.canonical) {
    return false
  }

  if (!host.sid) {
    return host.notice('No active session.', 'warning')
  }

  const title = arg.trim()
  const result = await mutateSession(host.gw, host.sid, 'branch', title ? { title } : {})
  const child = result.branched_session_id

  if (typeof child !== 'string' || !child) {
    throw new Error('the gateway did not name the branch')
  }

  if (host.stale() || !(await host.open(child))) {
    return
  }

  // Hermes names an untitled branch after its parent ("Bug hunt #2").
  const info = await host.gw.request<{ title?: string | null } | null>('session.info', { session_id: child }).catch(() => null)

  host.notice(`Branched → ${info?.title?.trim() || title || child}`)
}

async function save(host: SessionHost) {
  if (!host.sid) {
    return host.notice('No active session: nothing to save.', 'warning')
  }

  const r = await host.gw.request<{ file?: string } | null>('session.save', { session_id: host.sid })

  host.notice(r?.file ? `Conversation saved to: ${r.file}` : 'Could not save the conversation.', r?.file ? 'info' : 'error')
}

async function reloadEnv(host: SessionHost) {
  // The shared gateway reloads `.env` only for a session this view controls.
  const r = await host.gw.request<{ updated?: number } | null>('reload.env', host.sid ? { session_id: host.sid } : {})

  host.notice(`Reloaded .env (${plural(Number(r?.updated ?? 0), 'var')} updated).`)
}

async function reloadSkills(host: SessionHost) {
  // Bound to the session, so the rescan sees its repo's project-local skills.
  const r = await host.gw.request<{ output?: string } | null>('skills.reload', host.sid ? { session_id: host.sid } : {})

  host.panel('Reload Skills', r?.output?.trim() || 'Skills reloaded.')
}

interface ReloadMcp {
  message?: string
  /** The calling chat's tools: `applied`, `unchanged`, or `busy` (they apply after its turn). */
  session?: string
  unavailable?: string[]
}

/**
 * `/reload-mcp`: the shared gateway refuses it in `slash.exec` but serves `reload.mcp`, desktop's
 * add/toggle/repair call. Typing it is the confirmation the RPC asks for, as the desktop's button is.
 */
async function reloadMcp(host: SessionHost) {
  if (!host.canonical) {
    return false
  }

  const r = await host.gw.request<ReloadMcp | null>('reload.mcp', { confirm: true, ...(host.sid ? { session_id: host.sid } : {}) })

  host.panel('Reload MCP', r?.message?.trim() || 'MCP servers reloaded.')

  if (r?.unavailable?.length) {
    host.notice(`Did not connect: ${r.unavailable.join(', ')}.`, 'warning')
  }
}

interface RollbackList {
  enabled?: boolean
  checkpoints?: { hash: string; timestamp?: string; message?: string }[]
}

interface RollbackDiff {
  diff?: string
  stat?: string
}

interface RollbackRestore {
  success?: boolean
  error?: string
  message?: string
  reason?: string
  restored_to?: string
  history_removed?: number
}

/** `/rollback [list] | diff <checkpoint> | <checkpoint> [file]`: the session's filesystem checkpoints. */
async function rollback(host: SessionHost, arg: string) {
  if (!host.sid) {
    return host.notice('No active session: nothing to roll back.', 'warning')
  }

  const [first = '', ...rest] = arg.trim().split(/\s+/).filter(Boolean)
  const sub = first.toLowerCase()

  if (!sub || sub === 'list' || sub === 'ls') {
    const r = await host.gw.request<RollbackList | null>('rollback.list', { session_id: host.sid })
    const checkpoints = r?.checkpoints ?? []

    if (!r?.enabled) {
      return host.notice('Checkpoints are not enabled.')
    }

    if (!checkpoints.length) {
      return host.notice('No checkpoints found.')
    }

    return host.panel(
      'Rollback checkpoints',
      checkpoints
        .map((c, i) => `${i + 1}. ${c.hash.slice(0, 10)}  ${[c.timestamp, c.message].filter(Boolean).join(' · ') || '(no metadata)'}`)
        .join('\n')
    )
  }

  if (sub === 'diff') {
    if (!rest[0]) {
      return host.notice('Usage: /rollback diff <checkpoint>', 'warning')
    }

    // The plain diff: `rendered` is painted for a terminal.
    const r = await host.gw.request<RollbackDiff | null>('rollback.diff', { hash: rest[0], session_id: host.sid })
    const text = [r?.stat?.trim(), r?.diff?.trim()].filter(Boolean).join('\n\n')

    return text ? host.panel('Rollback diff', text) : host.notice('No changes since this checkpoint.')
  }

  const file = rest.join(' ').trim()
  const r = await host.gw.request<RollbackRestore | null>('rollback.restore', {
    ...(file ? { file_path: file } : {}),
    hash: first,
    session_id: host.sid
  })

  if (!r?.success) {
    return host.notice(`Rollback failed: ${r?.error || r?.message || 'unknown error'}`, 'error')
  }

  // A whole-tree restore also rewinds the transcript to before the newest user turn.
  if ((r.history_removed ?? 0) > 0) {
    await host.reload()
  }

  host.notice(`Rollback restored ${file || 'the workspace'}: ${r.reason || r.message || r.restored_to || 'restored'}`)
}

/** Runs a command, reporting a gateway refusal as `/<name> failed: …`. */
const guarded =
  (name: string, run: SessionCommand['run']): SessionCommand['run'] =>
  async (host, arg) => {
    try {
      return await run(host, arg)
    } catch (e) {
      host.notice(`/${name} failed: ${errorText(e)}`, 'error')
    }
  }

const COMMANDS: readonly SessionCommand[] = [
  { name: 'undo', run: host => rewind(host, 'undo') },
  { name: 'retry', run: host => rewind(host, 'retry') },
  { aliases: ['compact'], name: 'compress', run: compress },
  { aliases: ['fork'], name: 'branch', run: branch },
  { name: 'save', run: save },
  { name: 'reload', run: reloadEnv },
  { aliases: ['reload_skills'], name: 'reload-skills', run: reloadSkills },
  { aliases: ['reload_mcp'], name: 'reload-mcp', run: reloadMcp },
  { name: 'rollback', run: rollback }
]

export const SESSION_COMMANDS: readonly SessionCommand[] = COMMANDS.map(c => ({ ...c, run: guarded(c.name, c.run) }))
