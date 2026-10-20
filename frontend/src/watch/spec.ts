// Opening a subagent beside the chat: a Tern split running a second `hermes tern` in watch mode
// (and `hermes update` below the chat, for /update).
// `tern split` starts its command in Tern's own environment, so what the watcher needs (the
// profile's home, which agent) travels on its command line through `env`.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { LiveSessionId, StoredSessionId } from '../core/ids.js'
import type { Subagent } from '../model.js'
import { readWatchSpecText } from '../wire/files.js'

const run = promisify(execFile)

/** The variable carrying a watcher's spec from the launching frontend to the watching one. */
export const WATCH_ENV = 'HERMES_TERN_WATCH'

/** Which agent a watcher shows. */
export interface WatchSpec {
  /** The delegating session's runtime id (for subagent.list / steer / interrupt). */
  sid: LiveSessionId
  /** Its stored id, when it differs (children name either as their parent). */
  stored?: StoredSessionId | undefined
  subagent: string
  name: string
  goal: string
  index: number
  log?: string | undefined
  startedAt: number
}

/** The spec this process was launched to watch; undefined for a chat pane (or a spec it cannot read). */
export function readWatchSpec(env: NodeJS.ProcessEnv = process.env): WatchSpec | undefined {
  return readWatchSpecText(env[WATCH_ENV])
}

export function specOf(a: Subagent, name: string, sid: LiveSessionId, stored: StoredSessionId | null): WatchSpec {
  // The two kinds differ in general; the shared gateway names one id for both.
  const live: string = sid

  return {
    goal: a.goal,
    index: a.index,
    log: a.logPath,
    name,
    sid,
    startedAt: a.startedAt,
    stored: stored && stored !== live ? stored : undefined,
    subagent: a.id
  }
}

/** The one sidebar this pane opened, so a new one replaces it instead of piling up splits. */
let sidebar: string | undefined

/**
 * This pane and `hermes <args>` as a split's command line, `vars` set first. Undefined when this
 * isn't a Tern pane Tern's CLI can reach (over ssh, say) or the launcher named no interpreter.
 */
function hermesSplit(env: NodeJS.ProcessEnv, vars: readonly string[], args: readonly string[]) {
  const pane = env['TERN_PANE']
  const python = env['HERMES_PYTHON']
  // The `hermes` wrapper puts its checkout on sys.path; the bare interpreter needs it said.
  const src = env['HERMES_PYTHON_SRC_ROOT']

  if (!pane || !python || !src) {
    return undefined
  }

  const command = [
    'env',
    `PYTHONPATH=${src}`,
    ...(env['HERMES_HOME'] ? [`HERMES_HOME=${env['HERMES_HOME']}`] : []),
    ...vars,
    python,
    '-m',
    'hermes_cli.main',
    ...args
  ]

  return { command, pane }
}

/**
 * Opens `spec` in a split right of this pane, closing the sidebar opened before. False when
 * this isn't a Tern pane Tern's CLI can reach (over ssh, say): the caller falls back.
 */
export async function openSidebar(spec: WatchSpec, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const split = hermesSplit(env, [`${WATCH_ENV}=${JSON.stringify(spec)}`], ['tern'])

  if (!split) {
    return false
  }

  if (sidebar) {
    await run('tern', ['close', sidebar]).catch(() => undefined)
    sidebar = undefined
  }

  try {
    const { stdout } = await run('tern', ['split', split.pane, 'right', '--cwd', cwd, '--', ...split.command])
    sidebar = stdout.trim().split(/\s+/).at(-1) || undefined

    return true
  } catch {
    return false
  }
}

/**
 * Runs `hermes <args>` in a split below this pane (`/update`), kept open after it ends so its
 * last lines stay readable. False when Tern's CLI cannot reach this pane.
 */
export async function openHermesSplit(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const split = hermesSplit(env, [], args)

  if (!split) {
    return false
  }

  try {
    await run('tern', ['split', split.pane, 'down', '--cwd', cwd, '--keep-open', '--', ...split.command])

    return true
  } catch {
    return false
  }
}
