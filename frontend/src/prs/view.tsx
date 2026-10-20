// One pull request, as GitHub and T3 Code's PR panel show it: a header (repository and number,
// state, title, author, branches, size, checks), then three tabs: Conversation (the description
// and every comment, review, review thread and commit in order, each drawn as GitHub draws it),
// Checks (grouped, failures first) and Files (each file as Tern's own edit card with its diff).
// The actions sit in a bar of their own. The PR aside and the sheet draw this view; it owns no
// surface. Each tab's content is drawn in its own file (conversation.tsx, checks.tsx, files.tsx),
// and look.ts holds the state and checks tones the PR pill shares.

import type { JSX, Key, ScrollTo, Tone } from '@stencil-hq/tern'

import { copyToClipboard } from '../clipboard.js'
import { optional } from '../core/assert.js'
import { errorText } from '../core/errors.js'
import { Flash } from '../core/flash.js'
import { type PrKey, prKey } from '../core/ids.js'
import { clip, plural } from '../core/text.js'
import { checksSummary, failedRuns, type MergeMethod, type PullRequest } from '../github/pullRequest.js'
import { shown } from '../github/remote.js'
import type { Entry, PrAction, PullRequests } from '../github/store.js'
import { relative } from '../view/format.js'
import { button, type ButtonProps } from '../view/ui/button.js'

import { checksTab } from './checks.js'
import { conversation } from './conversation.js'
import { filesTab, type PrDensity } from './files.js'
import { checksIcon, checksTone, prTone, stateLabel, stateTone } from './look.js'

export type PrTab = 'checks' | 'conversation' | 'files'

export const PR_TABS: PrTab[] = ['conversation', 'checks', 'files']

/** What a place that shows the view lends it. */
export interface PrViewHost {
  readonly prs: PullRequests
  changed(): void
  notice(text: string, tone: 'error' | 'info' | 'warning'): void
  /** Opens a URL in the browser. */
  open(url: string): void
  /** Scrolls the scroll container holding node `id`. */
  scroll?(id: string, to: ScrollTo): void
  /** Brings node `id` into view. */
  reveal?(id: string): void
}

const METHOD_LABEL: Record<MergeMethod, string> = { merge: 'Merge', rebase: 'Rebase and merge', squash: 'Squash and merge' }
const DECISION: Record<string, [string, Tone]> = {
  APPROVED: ['Approved', 'success'],
  CHANGES_REQUESTED: ['Changes requested', 'error'],
  REVIEW_REQUIRED: ['Review required', 'warning']
}

/** The PR the view shows: its key and entry, and its pull request once GitHub has answered. */
export type PrSelection = { key: PrKey; entry: Entry; pr: PullRequest } | { key: PrKey; entry: Entry; pr: undefined }

export class PrView {
  readonly #host: PrViewHost
  #selected: PrKey | undefined
  #tab: PrTab = 'conversation'
  #confirm: 'close' | 'merge' | undefined
  /** The PR whose URL was just copied, while its button says so. */
  readonly #copied = new Flash<PrKey | undefined>(() => this.#host.changed())
  /** The node id the body's nodes sit under, from the last render (for scroll and reveal). */
  #bodyId = ''

  constructor(host: PrViewHost, focus?: PrKey) {
    this.#host = host
    this.#selected = focus
  }

  dispose() {
    this.#copied.dispose()
  }

  /** The PRs in the order the switcher lists them: newest link first. */
  keys(): PrKey[] {
    return this.#host.prs.entries().map(e => prKey(e.ref)).toReversed()
  }

  /** The PR shown: the picked one while it is linked, else the newest. */
  selection(): PrSelection | undefined {
    const keys = this.keys()

    if (!this.#selected || !keys.includes(this.#selected)) {
      this.#selected = keys[0]
    }

    const key = this.#selected
    const entry = key ? this.#host.prs.get(key) : undefined

    return key && entry ? { entry, key, pr: entry.pr } : undefined
  }

  /** The shown PR's entry. */
  current(): Entry | undefined {
    return this.selection()?.entry
  }

  select(key: PrKey) {
    this.#selected = key
    this.#confirm = undefined
    this.#load()
    this.#host.changed()
  }

  setTab(tab: PrTab) {
    this.#tab = tab
    this.#confirm = undefined
    this.#load()
    this.#host.changed()
  }

  /** Step through the PRs (`[` and `]`). */
  step(by: number) {
    const keys = this.keys()
    const at = this.#selected ? keys.indexOf(this.#selected) : -1
    const next = keys[(at + by + keys.length) % keys.length]

    if (next) {
      this.select(next)
    }
  }

  /** Reads what the tab shows, once per PR update; asked on every render. */
  #load() {
    const s = this.selection()

    if (!s?.pr) {
      return
    }

    if (this.#tab === 'conversation') {
      this.#host.prs.activity(s.key).catch(() => {})
    } else if (this.#tab === 'files') {
      this.#host.prs.files(s.key).catch(() => {})
    }
  }

  can(action: PrAction): boolean {
    const s = this.selection()

    return s?.pr ? canAct(action, s.pr, this.#host.prs.busy(s.key)) : false
  }

  async act(action: PrAction) {
    this.#confirm = undefined

    const s = this.selection()

    if (!s?.pr || !canAct(action, s.pr, this.#host.prs.busy(s.key))) {
      return this.#host.changed()
    }

    try {
      await this.#host.prs.act(action, s.key)
    } catch (error) {
      this.#host.notice(errorText(error), 'error')
    }

    this.#host.changed()
  }

  /** Merge and close ask first. */
  ask(what: 'close' | 'merge') {
    if (this.can(what)) {
      this.#confirm = what
      this.#host.changed()
    }
  }

  copy() {
    const e = this.current()

    if (!e) {
      return
    }

    copyToClipboard(e.pr?.url ?? e.ref.url)
    this.#copied.set(this.#selected)
  }

  openOnGitHub(path = '') {
    const e = this.current()

    if (e) {
      this.#host.open(`${e.pr?.url ?? e.ref.url}${path}`)
    }
  }

  /** The keys the view takes; false for a key it leaves to its host (Escape, say). */
  onKey(k: Key): boolean {
    if (this.#confirm) {
      if (k.name === 'enter' || k.name === 'y') {
        void this.act(this.#confirm)
      } else if (k.name === 'escape' || k.name === 'n') {
        this.#confirm = undefined
        this.#host.changed()
      }

      return true
    }

    const bare = !k.ctrl && !k.alt && !k.meta
    const scroll = (to: ScrollTo) => this.#host.scroll?.(this.#bodyId, to)

    if (k.name === 'tab') {
      this.setTab(PR_TABS[(PR_TABS.indexOf(this.#tab) + (k.shift ? PR_TABS.length - 1 : 1)) % PR_TABS.length] ?? this.#tab)
    } else if (bare && (k.name === ']' || k.name === 'right')) {
      this.step(1)
    } else if (bare && (k.name === '[' || k.name === 'left')) {
      this.step(-1)
    } else if (bare && (k.name === 'down' || k.name === 'j')) {
      scroll('line-down')
    } else if (bare && (k.name === 'up' || k.name === 'k')) {
      scroll('line-up')
    } else if (k.name === 'page_down' || (bare && k.name === 'space')) {
      scroll('page-down')
    } else if (k.name === 'page_up') {
      scroll('page-up')
    } else if (k.name === 'home') {
      scroll('start')
    } else if (k.name === 'end') {
      scroll('end')
    } else if (bare && k.name === '1') {
      this.setTab('conversation')
    } else if (bare && k.name === '2') {
      this.setTab('checks')
    } else if (bare && k.name === '3') {
      this.setTab('files')
    } else if (bare && k.name === 'o') {
      this.openOnGitHub()
    } else if (bare && k.name === 'c' && !k.shift) {
      this.copy()
    } else if (bare && k.name === 'm') {
      this.ask('merge')
    } else if (bare && k.name === 'x') {
      this.ask('close')
    } else if (bare && k.name === 'd' && this.can('ready')) {
      void this.act('ready')
    } else if (bare && k.name === 'u' && this.can('update-branch')) {
      void this.act('update-branch')
    } else if (bare && k.name === 'f' && this.can('rerun')) {
      void this.act('rerun')
    } else if (k.name === 'r' && k.shift) {
      this.#host.prs.poke()
    } else {
      return false
    }

    return true
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────────────────────

  /** The switcher: one tab per PR, its dot its checks or state; `compact` drops the titles. Null with one PR. */
  switcher(compact = false): JSX.Element | null {
    const entries = this.#host.prs.entries().toReversed()

    if (entries.length < 2) {
      return null
    }

    return (
      <tabs
        key="switch"
        {...optional('active', this.#selected)}
        items={entries.map(e => ({
          id: prKey(e.ref),
          label: [{ s: prTone(e), t: '● ' }, { t: `#${e.ref.number}` }, ...(e.pr && !compact ? [{ s: 'muted', t: ` ${clip(e.pr.title, { max: 28 })}` }] : [])]
        }))}
        onSelect={ev => {
          const key = ev.item ? this.#host.prs.keyOf(ev.item) : undefined

          if (key) {
            this.select(key)
          }
        }}
        role="hermes.pr.switch"
      />
    )
  }

  /** The header: repository and number with the state, the title, who and when, the branches and size. */
  header(now: number): JSX.Element {
    const e = this.current()

    if (!e) {
      return <col key="head" role="hermes.pr.head" />
    }

    const pr = e.pr
    const decision = pr?.reviewDecision ? DECISION[pr.reviewDecision] : undefined

    return (
      <col gap="sm" key="head" role="hermes.pr.head">
        <row align="center" gap="sm" key="ref">
          <icon key="ic" name="merge" tone={pr ? stateTone(pr) : 'muted'} />
          <text grow={1} key="t" spans={[{ href: pr?.url ?? e.ref.url, s: 'dim', t: `${e.ref.repository} #${e.ref.number}` }]} wrap="none" />
          {pr && decision && pr.state === 'open' ? <badge key="review" shrink={0} text={decision[0]} tone={decision[1]} /> : null}
          {pr ? <badge key="state" shrink={0} text={stateLabel(pr)} tone={stateTone(pr)} /> : null}
        </row>
        <text key="title" role="hermes.pr.title" text={pr?.title ?? (e.error ? 'Could not read this pull request' : 'Reading GitHub…')} />
        {pr ? (
          <row align="center" gap="sm" key="meta" role="hermes.pr.meta" wrap>
            <text
              grow={1}
              key="who"
              spans={[
                { s: 'strong', t: pr.author },
                { s: 'muted', t: ` ${pr.state === 'merged' ? 'merged' : pr.state === 'closed' ? 'closed' : 'opened'} ` },
                { s: 'muted', t: relative(pr.mergedAt ?? pr.closedAt ?? pr.createdAt, now) },
                { s: 'dim', t: ` · updated ${relative(pr.updatedAt, now)}` }
              ]}
              wrap="none"
            />
            <text
              key="checkout"
              shrink={0}
              onClick={() => {
                copyToClipboard(`gh pr checkout ${pr.number}`)
                this.#host.notice(`Copied gh pr checkout ${pr.number}`, 'info')
              }}
              role="hermes.pr.checkout"
              spans={[{ s: 'mono dim', t: `gh pr checkout ${pr.number}` }]}
              title="Copy the checkout command"
              wrap="none"
            />
          </row>
        ) : (
          <text key="err" spans={[{ s: e.error ? 'error' : 'muted', t: e.error ?? '' }]} />
        )}
        {pr ? (
          <row align="center" gap="sm" key="branch" role="hermes.pr.branch">
            <text grow={1} key="b" spans={[{ s: 'mono muted', t: pr.base }, { s: 'dim', t: '  ←  ' }, { s: 'mono muted', t: pr.head }]} wrap="none" />
            <text
              key="size"
              role="hermes.pr.size"
              shrink={0}
              spans={[
                { s: 'muted', t: `${plural(pr.changedFiles, 'file')}  ` },
                { s: 'success', t: `+${pr.additions.toLocaleString()}` },
                { t: ' ' },
                { s: 'error', t: `−${pr.deletions.toLocaleString()}` }
              ]}
              wrap="none"
            />
          </row>
        ) : null}
      </col>
    )
  }

  /** The tab strip, the checks' state at its right. */
  tabBar(): JSX.Element {
    const e = this.current()
    const pr = e?.pr
    const comments = e && shown(e.activity).value?.filter(a => a.kind !== 'commit').length

    return (
      <row align="center" gap="sm" key="tabs" role="hermes.pr.tabs" wrap>
        <tabs
          active={this.#tab}
          items={[
            { id: 'conversation', label: comments ? `Conversation ${comments}` : 'Conversation' },
            { id: 'checks', label: pr?.checks.length ? `Checks ${pr.checks.length}` : 'Checks' },
            { id: 'files', label: pr ? `Files ${pr.changedFiles}` : 'Files' }
          ]}
          key="t"
          onSelect={ev => {
            const tab = PR_TABS.find(t => t === ev.item)

            if (tab) {
              this.setTab(tab)
            }
          }}
        />
        <spacer grow={1} key="fill" />
        {pr ? (
          <row align="center" gap="xs" key="checks" onClick={() => this.setTab('checks')} role="hermes.pr.checkstate" title="Checks">
            <icon key="i" name={checksIcon(pr)} tone={checksTone(pr)} />
            <text key="t" spans={[{ s: checksTone(pr), t: pr.checks.length ? checksSummary(pr.checks) : 'No checks reported' }]} wrap="none" />
          </row>
        ) : null}
      </row>
    )
  }

  /** The tab's content; `id` is the node id these nodes sit under. */
  body(id: string, now: number, density: PrDensity = 'wide'): JSX.Element[] {
    this.#bodyId = id
    this.#load()

    const s = this.selection()

    if (!s) {
      return [<text key="none" spans={[{ s: 'muted', t: 'No pull requests linked yet. Hermes links each PR it opens or works on.' }]} />]
    }

    const { entry: e, pr } = s

    if (!pr) {
      return [<text key="none" spans={[{ s: e.error ? 'error' : 'muted', t: e.error ?? 'Reading GitHub…' }]} />]
    }

    switch (this.#tab) {
      case 'checks':
        return checksTab(pr, now)

      case 'files':
        return filesTab(e, pr, id, density, node => this.#host.reveal?.(node))

      case 'conversation':
        return conversation(e, pr, now)
    }
  }

  /** The actions bar, or the question a merge or close asks first. */
  actions(): JSX.Element {
    const pr = this.current()?.pr
    const busy = this.#selected ? this.#host.prs.busy(this.#selected) : false
    const method = pr?.mergeMethods[0] ?? 'merge'
    const confirm = this.#confirm

    if (confirm && pr) {
      const merge = confirm === 'merge'

      return (
        <row align="center" gap="sm" key="actions" role="omp.actions">
          <text
            key="q"
            spans={[{ t: merge ? `${METHOD_LABEL[method]} #${pr.number} into ` : `Close #${pr.number} without merging?` }, ...(merge ? [{ s: 'mono', t: `${pr.base}?` }] : [])]}
          />
          <spacer grow={1} key="fill" />
          {prButton({
            hint: 'esc',
            key: 'no',
            label: 'Cancel',
            onClick: () => {
              this.#confirm = undefined
              this.#host.changed()
            }
          })}
          {prButton({
            hint: 'enter',
            key: 'yes',
            kind: merge ? 'primary' : 'danger',
            label: merge ? METHOD_LABEL[method] : 'Close PR',
            onClick: () => void this.act(confirm)
          })}
        </row>
      )
    }

    return (
      <row align="center" gap="sm" key="actions" role="omp.actions">
        {this.can('close') ? prButton({ hint: 'x', key: 'close', kind: 'danger', label: 'Close PR', onClick: () => this.ask('close') }) : null}
        {this.can('reopen') ? prButton({ key: 'reopen', label: 'Reopen', onClick: () => void this.act('reopen') }) : null}
        {this.can('ready') ? prButton({ hint: 'd', key: 'ready', label: 'Ready for review', onClick: () => void this.act('ready') }) : null}
        {this.can('update-branch')
          ? prButton({ hint: 'u', key: 'update', label: 'Update branch', onClick: () => void this.act('update-branch') })
          : null}
        {this.can('rerun') ? prButton({ hint: 'f', key: 'rerun', label: 'Re-run failed', onClick: () => void this.act('rerun') }) : null}
        <spacer grow={1} key="fill" />
        {prButton({
          hint: 'c',
          key: 'copy',
          label: this.#copied.value && this.#copied.value === this.#selected ? 'Copied' : 'Copy URL',
          onClick: () => this.copy()
        })}
        {prButton({ hint: 'o', key: 'open', label: 'Open on GitHub', onClick: () => this.openOnGitHub() })}
        {this.can('merge')
          ? prButton({ hint: 'm', key: 'merge', kind: 'primary', label: busy ? 'Working…' : METHOD_LABEL[method], onClick: () => this.ask('merge') })
          : null}
      </row>
    )
  }
}

/** The action bar's buttons: the key in the tooltip only (the bar names none), the label on one line. */
const prButton = (b: Omit<ButtonProps, 'keys' | 'wrap'>) => button({ ...b, wrap: 'none' })

/** Whether `action` applies to `pr` as it stands; none while another action on it is in flight. */
function canAct(action: PrAction, pr: PullRequest, busy: boolean): boolean {
  if (busy) {
    return false
  }

  switch (action) {
    case 'merge':
      return pr.state === 'open' && !pr.draft && pr.canUpdate && pr.mergeable !== 'conflicting'

    case 'ready':
      return pr.state === 'open' && pr.draft && pr.canUpdate

    case 'close':
      return pr.state === 'open' && pr.canUpdate

    case 'reopen':
      return pr.state === 'closed' && pr.canUpdate

    case 'update-branch':
      return pr.state === 'open' && (pr.behindBy ?? 0) > 0

    case 'rerun':
      return pr.state === 'open' && failedRuns(pr.checks).length > 0

    case 'draft':
      return false
  }
}
