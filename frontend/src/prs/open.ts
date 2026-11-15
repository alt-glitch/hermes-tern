// Opening the session's PRs: the Tern plugin `prs` shows the pane's list file (listFile.ts) in a
// block beside the chat, with a page per PR. Without that plugin on this host, the PR opens on
// GitHub and the transcript says how to install the plugin.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { parseJson, record } from '../wire/json.js'

import type { PrRef } from './links.js'

const run = promisify(execFile)

export const INSTALL = 'tern plugin install github.com/alt-glitch/tern-plugins/prs'

/** Opens `url` in the default browser on this machine. */
export function openUrl(url: string) {
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => {})
}

/** Whether Tern on this host has the `prs` plugin loaded. */
export async function prsPluginReady(): Promise<boolean> {
  try {
    const { stdout } = await run('tern', ['plugin', 'list', '--json'], { timeout: 5000 })
    const plugins = record(parseJson(stdout))?.['plugins']

    return Array.isArray(plugins) && plugins.some(p => record(p)?.['id'] === 'prs' && record(p)?.['status'] === 'ready')
  } catch {
    return false
  }
}

export interface OpenPrsHost {
  /** The links, oldest first. */
  entries(): readonly PrRef[]
  /** Writes the list file with `pick` as the PR to open; its path, '' when there is none to write. */
  writeList(pick?: PrRef): string
  notice(text: string, tone: 'error' | 'info' | 'warning'): void
  /** What `pick` is opened for: its page, or its review guide (which GitHub does not show). */
  purpose?: 'guide' | 'page'
}

export interface OpenPrsDeps {
  ready(): Promise<boolean>
  /** Runs `tern open` on the list file. */
  open(path: string): Promise<unknown>
  browse(url: string): void
}

const DEPS: OpenPrsDeps = { browse: openUrl, open: path => run('tern', ['open', path], { timeout: 10_000 }), ready: prsPluginReady }

/** Shows the session's PRs, `pick` (else the list) first, beside the chat; on GitHub without the plugin. */
export async function openPrs(host: OpenPrsHost, pick?: PrRef, deps: OpenPrsDeps = DEPS) {
  const path = host.writeList(pick)

  if (path && (await deps.ready())) {
    // The plugin's route opens or focuses the block and tells Tern it handled the open; `tern open`
    // then exits 1 ("cannot open in a file block") although the block shows, so its result says nothing.
    await deps.open(path).catch(() => undefined)

    return
  }

  if (host.purpose === 'guide' && pick) {
    host.notice(`The review guide for #${pick.number} is ready. To see it beside the chat, install Tern's PR plugin: ${INSTALL}`, 'info')

    return
  }

  const target = pick ?? host.entries().at(-1)

  if (target) {
    deps.browse(target.url)
  }

  host.notice(`${target ? `Opened #${target.number} on GitHub. ` : ''}To see pull requests beside the chat, install Tern's PR plugin: ${INSTALL}`, 'info')
}

/** The PR pill: the newest linked PR, or how many there are. */
export function prsPill(refs: readonly PrRef[]): { text: string; tone: 'muted' } | undefined {
  const newest = refs.at(-1)

  return newest ? { text: refs.length === 1 ? `#${newest.number}` : `${refs.length} PRs`, tone: 'muted' } : undefined
}
