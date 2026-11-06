// The session's pull requests. The PR pill (and ⌥P) drops up a tray of every linked PR; a pick
// docks that PR at the chat's right edge (prs/aside.tsx), the chat going on beside it. Where Tern
// has no aside, the PR opens in a sheet over the chat instead. Both draw prs/view.tsx.

import { execFile } from 'node:child_process'

import type { JSX, Key } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import { optional } from '../core/assert.js'
import { type PrKey, prKey } from '../core/ids.js'
import { checksState } from '../github/pullRequest.js'
import type { Entry } from '../github/store.js'
import { prTone, stateLabel } from '../prs/look.js'
import { PrView } from '../prs/view.js'
import type { PrsPill } from '../view/dock.js'
import { relative } from '../view/format.js'
import { button, pressable } from '../view/ui/button.js'

import type { Overlay } from './overlay.js'
import { tickWhileOpen } from './sheet.js'

/** What the pull request sheets reach of the app. */
export type PullRequestsSheetHost = Pick<
  ChatPorts,
  'changed' | 'close' | 'notice' | 'open' | 'openPrAside' | 'prs' | 'reveal' | 'scroll' | 'transcript'
>

export { stateLabel }

const SHEET = 'pull-requests'
const MENU = 'pull-requests-menu'
const TICK_MS = 30_000

/** Opens `url` in the default browser on this machine. */
export function openUrl(url: string) {
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => {})
}

/** `/prs` opens the newest PR, `/prs 22` PR #22. */
export function prsCommand(host: PullRequestsSheetHost, arg: string) {
  const n = Number(arg.trim().replace(/^#/, ''))
  const hit = Number.isInteger(n) && n > 0 ? host.prs.entries().find(e => e.ref.number === n) : undefined

  if (arg.trim() && !hit) {
    host.transcript.notice(`No linked pull request #${arg.trim().replace(/^#/, '')}.`, 'warning')

    return host.changed()
  }

  openPullRequests(host, hit ? prKey(hit.ref) : undefined)
}

/** Docks PR `focus` (a key; else the newest) at the chat's right edge. */
export function openPullRequests(host: PullRequestsSheetHost, focus?: PrKey) {
  const newest = host.prs.entries().at(-1)

  host.openPrAside(focus ?? (newest ? prKey(newest.ref) : undefined))
}

/** The PR sheet: the whole view over the chat, Escape closes it. */
export function openPrSheet(host: PullRequestsSheetHost, focus?: PrKey) {
  const view = new PrView(
    {
      changed: () => host.changed(),
      notice: (text, tone) => host.notice(text, tone),
      open: openUrl,
      prs: host.prs,
      reveal: id => host.reveal(id),
      scroll: (id, to) => host.scroll(id, to)
    },
    focus
  )

  host.prs.poke()

  const stopTicking = tickWhileOpen(host, TICK_MS)
  const close = () => host.close(overlay)

  const overlay: Overlay = {
    cancel: close,
    // Ends with the sheet, however it closed (Esc, a session switch replacing the overlays).
    onClose: () => {
      stopTicking()
      view.dispose()
    },
    key: SHEET,
    modal: true,
    node: id => {
      const now = Date.now()
      const body = `${id}.body`

      return (
        <overlay anchor="center" key={SHEET} modal role="hermes.pr.sheet" size="full">
          <col gap="none" key="frame" role="hermes.pr.frame">
            <row align="center" gap="sm" key="top" role="hermes.pr.top">
              {view.switcher() ?? <text key="title" spans={[{ s: 'strong', t: 'Pull request' }]} />}
              <spacer grow={1} key="fill" />
              {button({ hint: 'esc', key: 'x', keys: ['escape'], label: 'Close', onClick: close })}
            </row>
            {view.header(now)}
            {view.tabBar()}
            <col gap="md" key="body" role="hermes.pr.body">
              {view.body(body, now, 'wide')}
            </col>
            {view.actions()}
          </col>
        </overlay>
      )
    },
    onKey: (k: Key) => {
      if (view.onKey(k)) {
        return true
      }

      if (k.name === 'escape') {
        close()
      }

      return true
    }
  }

  host.open(overlay)
}

/**
 * The PR pill's menu: every linked PR, newest first, each with its state and checks; a pick
 * opens it where PRs open. Its foot says where that is and switches it.
 */
export function openPrMenu(host: PullRequestsSheetHost) {
  const entries = () => host.prs.entries().toReversed()
  const first = entries()[0]
  let selected = first ? prKey(first.ref) : undefined

  host.prs.poke()

  const close = () => host.close(overlay)

  const pick = (key: PrKey | undefined) => {
    close()

    if (key) {
      openPullRequests(host, key)
    }
  }

  const overlay: Overlay = {
    cancel: close,
    key: MENU,
    node: () => {
      const now = Date.now()

      return (
        <overlay anchor={{ node: 'dock.agents', side: 'above' }} key={MENU} role="hermes.pr.menu">
          <col gap="none" key="list" role="hermes.pr.menu.list">
            {entries().map(e => menuRow(e, now, prKey(e.ref) === selected, () => pick(prKey(e.ref))))}
          </col>
          <row align="center" gap="xs" key="foot" role="hermes.pr.menu.foot">
            <text key="l" spans={[{ s: 'dim', t: 'Opens beside the chat · ' }, { s: 'dim', t: '/prs 22 opens #22' }]} wrap="none" />
          </row>
        </overlay>
      )
    },
    onKey: (k: Key) => {
      const keys = entries().map(e => prKey(e.ref))
      const at = selected ? keys.indexOf(selected) : -1

      if (k.name === 'escape') {
        close()
      } else if (k.name === 'enter') {
        pick(selected)
      } else if (k.name === 'up' || k.name === 'k') {
        selected = keys[Math.max(0, at - 1)]
      } else if (k.name === 'down' || k.name === 'j') {
        selected = keys[Math.min(keys.length - 1, at + 1)]
      } else {
        return false
      }

      return true
    }
  }

  host.open(overlay)
}

function menuRow(e: Entry, now: number, on: boolean, onClick: () => void): JSX.Element {
  const pr = e.pr
  const what = !pr ? (e.error ? 'unreadable' : 'reading…') : pr.state !== 'open' ? stateLabel(pr).toLowerCase() : pr.checks.length ? `checks ${checksState(pr.checks)}` : stateLabel(pr).toLowerCase()

  return pressable(
    { key: prKey(e.ref), name: `${pr?.title ?? `#${e.ref.number}`}, ${e.ref.repository} #${e.ref.number}, ${what}`, onClick },
    <row align="center" gap="sm" key="face" {...optional('mark', on ? 'pick' : undefined)} role="hermes.pr.menu.row" title={pr?.url ?? e.ref.url}>
      <icon key="i" name="merge" tone={prTone(e)} />
      <col gap="none" grow={1} key="t" min={{ w: 0 }}>
        <text key="title" spans={[{ s: 'strong', t: pr?.title ?? `#${e.ref.number}` }]} truncate="end" wrap="none" />
        <text key="sub" spans={[{ s: 'dim', t: `${e.ref.repository} #${e.ref.number}` }]} truncate="end" wrap="none" />
      </col>
      <col align="end" gap="none" key="r">
        <text key="state" spans={[{ s: prTone(e), t: what }]} wrap="none" />
        <text key="at" spans={[{ s: 'dim', t: pr ? relative(pr.updatedAt, now) : '' }]} wrap="none" />
      </col>
    </row>
  )
}

/** The PR pill: the newest linked PR (`#22 · checks passing`), or how many there are. */
export function prsPill(entries: Entry[]): PrsPill | undefined {
  const newest = entries.at(-1)

  if (!newest) {
    return undefined
  }

  const open = entries.flatMap(e => (e.pr?.state === 'open' ? [e.pr] : []))
  const pr = newest.pr

  if (entries.length === 1) {
    const what = !pr ? '' : pr.state !== 'open' ? stateLabel(pr).toLowerCase() : pr.checks.length ? `checks ${checksState(pr.checks)}` : stateLabel(pr).toLowerCase()

    return { text: `#${newest.ref.number}${what ? ` · ${what}` : ''}`, tone: prTone(newest) }
  }

  const failing = open.some(p => checksState(p.checks) === 'failing')
  const pending = open.some(p => checksState(p.checks) === 'pending')

  return {
    text: `${entries.length} PRs${open.length ? ` · ${open.length} open` : ''}`,
    tone: failing ? 'error' : pending ? 'warning' : open.length ? 'success' : 'muted'
  }
}
