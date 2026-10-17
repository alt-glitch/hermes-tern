// Opening a subagent beside the chat: a Tern split running a second `hermes tern` in watch mode.
// `tern split` starts its command in Tern's own environment, so what the watcher needs (the
// profile's home, which agent) travels on its command line through `env`.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { Subagent } from '../model.js'

const run = promisify(execFile)

/** The variable carrying a watcher's spec from the launching frontend to the watching one. */
export const WATCH_ENV = 'HERMES_TERN_WATCH'

/** Which agent a watcher shows. */
export interface WatchSpec {
  /** The delegating session's runtime id (for subagent.list / steer / interrupt). */
  sid: string
  /** Its stored id, when it differs (children name either as their parent). */
  stored?: string
  subagent: string
  name: string
  goal: string
  index: number
  log?: string
  startedAt: number
}

export function readWatchSpec(env: NodeJS.ProcessEnv = process.env): WatchSpec | undefined {
  try {
    const raw = env[WATCH_ENV]
    const spec = raw ? (JSON.parse(raw) as WatchSpec) : undefined

    return spec && typeof spec.sid === 'string' && typeof spec.subagent === 'string' ? spec : undefined
  } catch {
    return undefined
  }
}

export function specOf(a: Subagent, name: string, sid: string, stored: string | null): WatchSpec {
  return {
    goal: a.goal,
    index: a.index,
    log: a.logPath,
    name,
    sid,
    startedAt: a.startedAt,
    stored: stored && stored !== sid ? stored : undefined,
    subagent: a.id
  }
}

/** The one sidebar this pane opened, so a new one replaces it instead of piling up splits. */
let sidebar: string | undefined

/**
 * Opens `spec` in a split right of this pane, closing the sidebar opened before. False when
 * this isn't a Tern pane Tern's CLI can reach (over ssh, say): the caller falls back.
 */
export async function openSidebar(spec: WatchSpec, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const pane = env.TERN_PANE
  const python = env.HERMES_PYTHON
  // The `hermes` wrapper puts its checkout on sys.path; the bare interpreter needs it said.
  const src = env.HERMES_PYTHON_SRC_ROOT

  if (!pane || !python || !src) {
    return false
  }

  if (sidebar) {
    await run('tern', ['close', sidebar]).catch(() => undefined)
    sidebar = undefined
  }

  const command = [
    'env',
    `PYTHONPATH=${src}`,
    ...(env.HERMES_HOME ? [`HERMES_HOME=${env.HERMES_HOME}`] : []),
    `${WATCH_ENV}=${JSON.stringify(spec)}`,
    python,
    '-m',
    'hermes_cli.main',
    'tern'
  ]

  try {
    const { stdout } = await run('tern', ['split', pane, 'right', '--cwd', cwd, '--', ...command])
    sidebar = stdout.trim().split(/\s+/).at(-1) || undefined

    return true
  } catch {
    return false
  }
}
