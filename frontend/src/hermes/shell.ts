// `!cmd` and `{!cmd}` in the composer, as Hermes' Ink TUI runs them (ui-tui/src/app/useSubmission.ts):
// one captured command through the shared gateway's `shell.exec` (gateway/session_shell.py), which runs
// it for a local session in its launch cwd and refuses sandboxed backends and dangerous commands.
import type { GatewayClient } from '@tui/gatewayClient.js'
import { describeRpcError } from '@tui/app/userMessages.js'
import { INTERPOLATION_RE } from '@tui/protocol/interpolation.js'

export interface ShellResult {
  stdout: string
  stderr: string
  code: number
}

/** The owner's refusals (its reason codes), in words. */
const REFUSALS: [string, string][] = [
  ['dangerous_command', 'Hermes refused to run a dangerous command'],
  ['unsupported_terminal_backend', 'this session runs commands in a sandbox, not on this machine'],
  ['permission_denied', 'shell commands run only for a local terminal session'],
  ['command_timeout', 'the command ran longer than 30 seconds'],
  ['cwd_unavailable', "the session's folder no longer exists"],
  ['command_failed', 'the command could not start']
]

/** Why a `shell.exec` failed, for the user. */
export function shellError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)

  return REFUSALS.find(([code]) => text.includes(code))?.[1] ?? describeRpcError(error)
}

/** Runs `command` for session `sid`. */
export async function shellExec(gw: Pick<GatewayClient, 'request'>, sid: string, command: string): Promise<ShellResult> {
  const r = await gw.request<Partial<ShellResult> | null>('shell.exec', { command, session_id: sid })

  if (!r || typeof r !== 'object') {
    throw new Error('invalid response: shell.exec')
  }

  return { code: typeof r.code === 'number' ? r.code : 0, stderr: r.stderr ?? '', stdout: r.stdout ?? '' }
}

/** What a run prints: its output, then `exit N` when it failed or printed nothing (as Ink shows it). */
export function shellLines(r: ShellResult): { text: string; failed: boolean }[] {
  const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim()

  return [
    ...(out ? [{ failed: false, text: out }] : []),
    ...(r.code !== 0 || !out ? [{ failed: r.code !== 0, text: `exit ${r.code}` }] : [])
  ]
}

/**
 * The `{!cmd}`s of `text` the user typed: one that also appears in `pasted` (text pasted into the
 * draft) stays as written, so pasting a log or a document never runs what it quotes.
 */
export function typedCommands(text: string, pasted: readonly string[] = []): RegExpExecArray[] {
  return [...text.matchAll(new RegExp(INTERPOLATION_RE.source, 'g'))].filter(m => !pasted.some(p => p.includes(m[0])))
}

/** `text` with every typed `{!cmd}` replaced by that command's output; throws when one could not run. */
export async function interpolate(gw: Pick<GatewayClient, 'request'>, sid: string, text: string, pasted: readonly string[] = []): Promise<string> {
  const matches = typedCommands(text, pasted)

  const results = await Promise.all(
    matches.map(async m => {
      const r = await shellExec(gw, sid, m[1] ?? '')

      return [r.stdout, r.stderr].filter(Boolean).join('\n').trim()
    })
  )

  return matches.reduceRight(
    (acc, m, i) => acc.slice(0, m.index) + (results[i] ?? '') + acc.slice((m.index ?? 0) + m[0].length),
    text
  )
}
