// The conversation this Tern pane shows, kept where `hermes tern` reads it when it starts again in
// the same pane (panes.py): after a crash, a kill or Tern's daemon restarting, the launcher resumes
// it. Written on every adopt (new, resume, reattach), removed when the user quits; a program that
// dies leaves it behind with a dead pid, which is what the launcher looks for.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { LaunchEnv } from '../config/env.js'
import { dataDir } from '../connections/cards.js'
import type { DurableSessionId } from '../core/ids.js'

/** What the pane file says: the plugin's launcher reads these names (panes.py). */
export interface PaneRecord {
  session_id: string
  cwd: string
  updated_at: number
  pid: number
}

/** The pane file of `pane` under the plugin's data folder. */
export const paneFile = (pane: string, dir = dataDir()) => join(dir, 'panes', `${pane}.json`)

/** Records that this pane shows session `sid` (nothing outside a Tern pane). */
export function markPane(launch: Pick<LaunchEnv, 'pane' | 'paneCwd'>, sid: DurableSessionId, dir = dataDir()) {
  if (!launch.pane) {
    return
  }

  const record: PaneRecord = { cwd: launch.paneCwd, pid: process.pid, session_id: sid, updated_at: Date.now() / 1000 }

  try {
    mkdirSync(join(dir, 'panes'), { recursive: true })
    writeFileSync(paneFile(launch.pane, dir), JSON.stringify(record))
  } catch {
    // Without the file a restarted pane starts a new session, as it did before.
  }
}

/** The user quit: a later `hermes tern` in this pane starts a new session. */
export function forgetPane(launch: Pick<LaunchEnv, 'pane'>, dir = dataDir()) {
  if (!launch.pane) {
    return
  }

  try {
    rmSync(paneFile(launch.pane, dir), { force: true })
  } catch {
    // A file left behind names this live pid until it exits; the launcher then resumes it.
  }
}
