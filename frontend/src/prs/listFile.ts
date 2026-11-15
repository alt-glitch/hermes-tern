// The pane's list file, `panes/<pane>.prs.json` under the plugin's data folder: the PRs the pane's
// conversation linked, in the format the Tern plugin `prs` reads (github.com/alt-glitch/tern-plugins,
// `prs/README.md` § List files). The plugin re-reads it every few seconds, so its "This session" tab
// follows the links; a new `selected` or `opened_at` opens that PR's page. Removed when the user quits.

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { dataDir } from '../config/dataDir.js'

import type { PrRef } from './links.js'

/** Version 1 of the list file. */
export interface PrList {
  version: 1
  title: string
  session_id: string
  /** The session's folder: the plugin adds the PR of the branch checked out there. */
  cwd: string
  prs: { url: string }[]
  /** `owner/repo#number`: the PR whose page to open. */
  selected?: string
  /** When `selected` was picked, so picking the same PR again opens it again. */
  opened_at?: number
}

export const prListFile = (pane: string, dir = dataDir()) => join(dir, 'panes', `${pane}.prs.json`)

/** The list file's contents for `refs`, with `pick` as the PR to open. */
export function prList(sessionId: string, cwd: string, refs: readonly PrRef[], pick?: PrRef, now = Date.now()): PrList {
  return {
    cwd,
    prs: refs.map(r => ({ url: r.url })),
    session_id: sessionId,
    title: 'This session',
    version: 1,
    ...(pick ? { opened_at: now, selected: `${pick.repository}#${pick.number}` } : {})
  }
}

/** Writes pane `pane`'s list file whole (a reader never sees half of it); its path, '' outside a Tern pane or on failure. */
export function writePrList(pane: string, list: PrList, dir = dataDir()): string {
  if (!pane) {
    return ''
  }

  const path = prListFile(pane, dir)

  try {
    mkdirSync(join(dir, 'panes'), { recursive: true })
    writeFileSync(`${path}.tmp`, JSON.stringify(list, null, 1))
    renameSync(`${path}.tmp`, path)

    return path
  } catch {
    return ''
  }
}

/** The user quit: the pane is a shell again and has no session's list. */
export function forgetPrList(pane: string, dir = dataDir()) {
  if (pane) {
    rmSync(prListFile(pane, dir), { force: true })
  }
}
