// Fork a stored conversation without replacing the current Tern pane. Donor:
// kvnloo/hermes-agent#556 (ui-tsp/src/fork-session.ts), adapted to this plugin's
// session.mutate compatibility path and its 'hermes tern' launcher.

import type { ChatPorts } from './app/ports.js'
import { errorText } from './core/errors.js'
import { mutateSession } from './hermes/mutate.js'
import { launchPane } from './pane-launcher.js'
import { isUnsupportedFork, requestDurableFork } from './wire/fork.js'

export type ForkHost = Pick<ChatPorts, 'busy' | 'control' | 'notice' | 'session'>
export type PaneLauncher = (argv: readonly string[], cwd: string) => Promise<boolean>

/** One inflight fork per running session; a repeated key or slash cannot create duplicate children. */
const pending = new WeakMap<object, Set<string>>()

/** A displayed recovery hint is also safe to paste into a shell, even for unusual profile names. */
export function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'"
}

function targetOf(raw: string): number | undefined | null {
  const value = raw.trim()

  if (!value) {
    return undefined
  }

  return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null
}

/**
 * Prefer Hermes' durable-only session.fork (no child agent is built in this process). The
 * currently pinned older gateway lacks that method, so only an untargeted fork may use the
 * existing revision-fenced 'branch' mutation. Never turn a requested message-id boundary into
 * a full-history branch: that would silently copy more conversation than the user chose.
 */
export async function forkSession(host: ForkHost, raw = '', open: PaneLauncher = launchPane): Promise<void> {
  const target = targetOf(raw)

  if (target === null) {
    host.notice('Usage: /fork [positive-durable-message-id]', 'warning')

    return
  }

  const control = host.control()
  const sid = control.sid

  if (!sid) {
    host.notice('Start a session before forking.', 'warning')

    return
  }

  if (control.busy || host.busy) {
    host.notice('Wait for the current turn to finish before forking.', 'warning')

    return
  }

  const gw = control.gw
  let active = pending.get(gw)

  if (!active) {
    active = new Set<string>()
    pending.set(gw, active)
  }

  if (active.has(sid)) {
    return
  }

  active.add(sid)

  // A late RPC must not borrow a newly shown session's profile or folder.
  const info = host.session.info
  const cwd = info?.cwd || process.cwd()
  const fallbackProfile = info && 'profile_name' in info && typeof info.profile_name === 'string'
    ? info.profile_name
    : undefined

  try {
    let child: string
    let profile: string | undefined
    let compatibility = false

    try {
      const fork = await requestDurableFork(gw, sid, target)
      child = fork.sessionId
      profile = fork.profile
    } catch (error) {
      if (target !== undefined || !isUnsupportedFork(error)) {
        throw error
      }

      if (control.stale()) {
        host.notice('Session changed before the fork could be saved.', 'warning')

        return
      }

      const branch = await mutateSession(gw, sid, 'branch', {})
      const saved = branch?.branched_session_id

      if (typeof saved !== 'string' || !saved.trim()) {
        throw new Error('The gateway did not return a saved branch id')
      }

      child = saved
      profile = fallbackProfile
      compatibility = true
    }

    const argv = ['tern', '--resume', child, ...(profile ? ['-p', profile] : [])]
    const hint = 'hermes ' + argv.map(shellQuote).join(' ')

    host.notice((compatibility ? 'Created compatible branch ' : 'Forked session ') + child + '. Resume with: ' + hint)

    if (compatibility) {
      host.notice('This gateway lacks session.fork; the compatible branch may omit tool-history details.', 'warning')
    }

    // The persisted fork survives both a failed launcher and switching the original pane.
    if (control.stale()) {
      return
    }

    try {
      if (await open(argv, cwd)) {
        host.notice('Opened fork ' + child + ' in a new Tern pane.')
      }
    } catch (error) {
      host.notice('Fork saved, but the Tern pane could not open: ' + errorText(error), 'error')
    }
  } catch (error) {
    host.notice('Could not fork session: ' + errorText(error), 'error')
  } finally {
    active.delete(sid)

    if (!active.size) {
      pending.delete(gw)
    }
  }
}
