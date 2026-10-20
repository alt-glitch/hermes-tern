// One pull request, as GitHub and T3 Code's PR panel show it: a header (repository and number,
// state, title, author, branches, size, checks), then three tabs: Conversation (the description
// and every comment, review, review thread and commit in order, each drawn as GitHub draws it),
// Checks (grouped, failures first) and Files (each file as Tern's own edit card with its diff).
// The actions sit in a bar of their own. The PR aside and the sheet draw this view; it owns no
// surface.

import type { JSX, Key, ScrollTo, SpanData, Tone } from '@stencil-hq/tern'
import { node } from '@stencil-hq/tern'

import { copyToClipboard } from '../clipboard.js'
import { langOf } from '../code/lang.js'
import { errorText } from '../core/errors.js'
import { type PrKey, prKey } from '../core/ids.js'
import {
  type ActivityItem,
  type Check,
  checkGroup,
  checksState,
  checksSummary,
  failedRuns,
  type MergeMethod,
  type PrFile,
  type PullRequest
} from '../github/pullRequest.js'
import type { Entry, PrAction, PullRequests } from '../github/store.js'
import { relative } from '../processes/cron.js'
import { clip, durationWhole, plural } from '../view/format.js'
import { button, type ButtonProps } from '../view/ui/button.js'

import { type BodyLinks, bodyNodes } from './body.js'

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

/** How much room the view has: `wide` draws the files beside their list. */
export type PrDensity = 'narrow' | 'wide'

const METHOD_LABEL: Record<MergeMethod, string> = { merge: 'Merge', rebase: 'Rebase and merge', squash: 'Squash and merge' }
const COPIED_MS = 1500
/** A diff longer than this many lines starts folded. */
const LONG_DIFF = 400

export function stateLabel(pr: PullRequest): string {
  return pr.state === 'open' ? (pr.draft ? 'Draft' : 'Open') : pr.state === 'merged' ? 'Merged' : 'Closed'
}

export function stateTone(pr: PullRequest): Tone {
  return pr.state === 'merged' ? 'accent' : pr.state === 'closed' ? 'error' : pr.draft ? 'muted' : 'success'
}

export function checksTone(pr: PullRequest): Tone {
  const s = checksState(pr.checks)

  return s === 'failing' ? 'error' : s === 'pending' ? 'warning' : s === 'passing' ? 'success' : 'muted'
}

/** The dot of a PR in a list: its checks while open, else its state. */
export function prTone(e: Entry): Tone {
  return e.pr ? (e.pr.state === 'open' && e.pr.checks.length ? checksTone(e.pr) : stateTone(e.pr)) : 'muted'
}

export function prIcon(e: Entry): string {
  return e.pr?.state === 'merged' ? 'merge' : e.pr?.state === 'closed' ? 'x-circle' : e.pr?.draft ? 'pr' : 'pr'
}

const CHECK: Record<Check['status'], { tone: Tone; icon: string; word: string }> = {
  'action-required': { icon: 'pending', tone: 'warning', word: 'waiting for approval' },
  cancelled: { icon: 'cancelled', tone: 'muted', word: 'cancelled' },
  failure: { icon: 'failed', tone: 'error', word: 'failed' },
  neutral: { icon: 'minus', tone: 'muted', word: 'neutral' },
  pending: { icon: 'running', tone: 'warning', word: 'running' },
  skipped: { icon: 'minus', tone: 'muted', word: 'skipped' },
  success: { icon: 'success', tone: 'success', word: 'passed' }
}

const REVIEW: Record<string, [string, Tone]> = {
  APPROVED: ['approved these changes', 'success'],
  CHANGES_REQUESTED: ['requested changes', 'error'],
  COMMENTED: ['reviewed', 'muted'],
  DISMISSED: ['reviewed (dismissed)', 'muted'],
  PENDING: ['started a review', 'muted']
}

const DECISION: Record<string, [string, Tone]> = {
  APPROVED: ['Approved', 'success'],
  CHANGES_REQUESTED: ['Changes requested', 'error'],
  REVIEW_REQUIRED: ['Review required', 'warning']
}

export class PrView {
  readonly #host: PrViewHost
  selected: PrKey | undefined
  tab: PrTab = 'conversation'
  #confirm: 'close' | 'merge' | undefined
  #copied: string | undefined
  #copiedTimer: NodeJS.Timeout | undefined
  /** The node id the body's nodes sit under, from the last render (for scroll and reveal). */
  #bodyId = ''

  constructor(host: PrViewHost, focus?: PrKey) {
    this.#host = host
    this.selected = focus
  }

  dispose() {
    clearTimeout(this.#copiedTimer)
  }

  /** The PRs in the order the switcher lists them: newest link first. */
  keys(): PrKey[] {
    return this.#host.prs.entries().map(e => prKey(e.ref)).toReversed()
  }

  current(): Entry | undefined {
    const keys = this.keys()

    if (!this.selected || !keys.includes(this.selected)) {
      this.selected = keys[0]
    }

    return this.selected ? this.#host.prs.get(this.selected) : undefined
  }

  select(key: PrKey) {
    this.selected = key
    this.#confirm = undefined
    this.#load()
    this.#host.changed()
  }

  setTab(tab: PrTab) {
    this.tab = tab
    this.#confirm = undefined
    this.#load()
    this.#host.changed()
  }

  /** Step through the PRs (`[` and `]`). */
  step(by: number) {
    const keys = this.keys()
    const at = this.selected ? keys.indexOf(this.selected) : -1

    if (keys.length) {
      this.select(keys[(at + by + keys.length) % keys.length]!)
    }
  }

  /** Reads what the tab shows, once per PR update; asked on every render. */
  #load() {
    const e = this.current()

    if (!e?.pr || !this.selected) {
      return
    }

    if (this.tab === 'conversation') {
      this.#host.prs.activity(this.selected).catch(() => {})
    } else if (this.tab === 'files') {
      this.#host.prs.files(this.selected).catch(() => {})
    }
  }

  can(action: PrAction): boolean {
    const pr = this.current()?.pr

    if (!pr || this.#host.prs.busy(this.selected!)) {
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

      default:
        return false
    }
  }

  async act(action: PrAction) {
    this.#confirm = undefined

    if (!this.can(action)) {
      return this.#host.changed()
    }

    try {
      await this.#host.prs.act(action, this.selected!)
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
    this.#copied = this.selected
    clearTimeout(this.#copiedTimer)
    this.#copiedTimer = setTimeout(() => {
      this.#copied = undefined
      this.#host.changed()
    }, COPIED_MS)
    this.#host.changed()
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
      this.setTab(PR_TABS[(PR_TABS.indexOf(this.tab) + (k.shift ? PR_TABS.length - 1 : 1)) % PR_TABS.length]!)
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
        active={this.selected}
        items={entries.map(e => ({
          id: prKey(e.ref),
          label: [{ s: prTone(e), t: '● ' }, { t: `#${e.ref.number}` }, ...(e.pr && !compact ? [{ s: 'muted', t: ` ${clip(e.pr.title, { max: 28 })}` }] : [])]
        }))}
        key="switch"
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
    const comments = e?.activity?.filter(a => a.kind !== 'commit').length

    return (
      <row align="center" gap="sm" key="tabs" role="hermes.pr.tabs" wrap>
        <tabs
          active={this.tab}
          items={[
            { id: 'conversation', label: comments ? `Conversation ${comments}` : 'Conversation' },
            { id: 'checks', label: pr?.checks.length ? `Checks ${pr.checks.length}` : 'Checks' },
            { id: 'files', label: pr ? `Files ${pr.changedFiles}` : 'Files' }
          ]}
          key="t"
          onSelect={ev => {
            if (PR_TABS.includes(ev.item as PrTab)) {
              this.setTab(ev.item as PrTab)
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

    const e = this.current()

    if (!e) {
      return [<text key="none" spans={[{ s: 'muted', t: 'No pull requests linked yet. Hermes links each PR it opens or works on.' }]} />]
    }

    if (!e.pr) {
      return [<text key="none" spans={[{ s: e.error ? 'error' : 'muted', t: e.error ?? 'Reading GitHub…' }]} />]
    }

    switch (this.tab) {
      case 'checks':
        return checksTab(e.pr, now)

      case 'files':
        return this.#filesTab(e, id, density)

      default:
        return conversation(e, now)
    }
  }

  /** The actions bar, or the question a merge or close asks first. */
  actions(): JSX.Element {
    const pr = this.current()?.pr
    const busy = this.selected ? this.#host.prs.busy(this.selected) : false
    const method = pr?.mergeMethods[0] ?? 'merge'

    if (this.#confirm && pr) {
      const merge = this.#confirm === 'merge'

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
            onClick: () => void this.act(this.#confirm!)
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
          label: this.#copied && this.#copied === this.selected ? 'Copied' : 'Copy URL',
          onClick: () => this.copy()
        })}
        {prButton({ hint: 'o', key: 'open', label: 'Open on GitHub', onClick: () => this.openOnGitHub() })}
        {this.can('merge')
          ? prButton({ hint: 'm', key: 'merge', kind: 'primary', label: busy ? 'Working…' : METHOD_LABEL[method], onClick: () => this.ask('merge') })
          : null}
      </row>
    )
  }

  #filesTab(e: Entry, id: string, density: PrDensity): JSX.Element[] {
    const pr = e.pr!

    if (!e.files) {
      return [<text key="load" spans={[{ s: e.filesError ? 'error' : 'muted', t: e.filesError ?? 'Reading the files…' }]} />]
    }

    if (!e.files.length) {
      return [<text key="none" spans={[{ s: 'muted', t: 'No files changed.' }]} />]
    }

    const cards = e.files.map((f, i) => fileCard(f, `f${i}`))

    if (density === 'narrow') {
      return cards
    }

    const list = (
      <col gap="none" key="list" role="hermes.pr.filelist">
        {e.files.map((f, i) => {
          const slash = f.path.lastIndexOf('/')

          return (
            <row align="center" gap="sm" key={`l${i}`} onClick={() => this.#host.reveal?.(`${id}.diffs.f${i}`)} role="hermes.pr.fileitem" title={f.path}>
              <icon key="i" name="file" tone={FILE_TONE[f.status]} />
              <text
                grow={1}
                key="p"
                spans={[...(slash > 0 ? [{ s: 'dim', t: f.path.slice(0, slash + 1) }] : []), { t: f.path.slice(slash + 1) }]}
                truncate="start"
                wrap="none"
              />
              <text key="n" shrink={0} spans={[{ s: 'success', t: `+${f.additions}` }, { t: ' ' }, { s: 'error', t: `−${f.deletions}` }]} wrap="none" />
            </row>
          )
        })}
        {e.files.length < pr.changedFiles ? <text key="more" spans={[{ s: 'muted', t: `${pr.changedFiles - e.files.length} more on GitHub` }]} /> : null}
      </col>
    )

    return [
      <row align="start" gap="md" key="files" role="hermes.pr.files">
        {list}
        <col gap="sm" grow={1} key="diffs" min={{ w: 0 }}>
          {cards}
        </col>
      </row>
    ]
  }
}

const FILE_TONE: Record<string, Tone> = { added: 'success', removed: 'error', renamed: 'info' }

const FILE_TITLE: Record<string, string> = { added: 'Added', copied: 'Copied', modified: 'Changed', removed: 'Deleted', renamed: 'Renamed' }

/** A file as Tern's own edit card: its path in the head, its diff in the body. */
function fileCard(f: PrFile, key: string): JSX.Element {
  const lines = f.patch ? f.patch.split('\n').length : 0

  return node(
    'tool',
    {
      badges: f.previous ? [{ text: `from ${f.previous}` }] : undefined,
      collapsed: f.status === 'removed' || lines > LONG_DIFF,
      collapsible: true,
      key,
      meta: [`+${f.additions} −${f.deletions}`],
      name: f.status === 'added' ? 'write' : 'edit',
      role: 'hermes.pr.file',
      status: 'done',
      target: f.path,
      targetKind: 'path',
      title: FILE_TITLE[f.status] ?? 'Changed'
    },
    f.patch
      ? [<diff key="d" lang={langOf(f.path)} path={f.path} text={f.patch} />]
      : [<text key="none" spans={[{ s: 'muted', t: 'Binary, or too large to show here.' }]} />]
  )
}

function checksIcon(pr: PullRequest): string {
  const s = checksState(pr.checks)

  return s === 'failing' ? 'failed' : s === 'pending' ? 'running' : s === 'passing' ? 'success' : 'info'
}

/** The action bar's buttons: the key in the tooltip only (the bar names none), the label on one line. */
const prButton = (b: Omit<ButtonProps, 'keys' | 'wrap'>) => button({ ...b, wrap: 'none' })

// ── Conversation ──────────────────────────────────────────────────────────────────────────────

/** The description, then every event in order, as GitHub's Conversation tab lists them. */
function conversation(e: Entry, now: number): JSX.Element[] {
  const pr = e.pr!
  const links = { repo: pr.url.replace(/\/pull\/\d+.*$/, '') }
  const out: JSX.Element[] = [
    comment('desc', [{ s: 'strong', t: pr.author }, { s: 'muted', t: ' opened this' }], pr.createdAt, now, pr.body, pr.url, links, 'No description provided.')
  ]

  if (!e.activity) {
    out.push(<text key="load" spans={[{ s: e.activityError ? 'error' : 'muted', t: e.activityError ?? 'Reading the conversation…' }]} />)

    return out
  }

  // Runs of commits fold into one line each, as GitHub groups pushes.
  let commits: ActivityItem[] = []

  const flush = () => {
    if (commits.length) {
      out.push(commitRun(commits, `c${out.length}`, now))
      commits = []
    }
  }

  e.activity.forEach((a, i) => {
    if (a.kind === 'commit') {
      commits.push(a)

      return
    }

    flush()

    if (a.kind === 'review') {
      const [verb, tone] = REVIEW[a.state ?? 'COMMENTED'] ?? REVIEW.COMMENTED!

      // A review with no words is a verdict line, not a card.
      if (!a.body.trim()) {
        out.push(
          <row align="center" gap="sm" key={`a${i}`} role="hermes.pr.event">
            <icon key="i" name={a.state === 'APPROVED' ? 'check' : a.state === 'CHANGES_REQUESTED' ? 'warn' : 'message'} tone={tone} />
            <text key="t" spans={[{ s: 'strong', t: a.author }, { s: tone === 'muted' ? 'muted' : tone, t: ` ${verb}` }, { s: 'dim', t: ` · ${relative(a.at, now)}` }]} />
          </row>
        )

        return
      }

      out.push(comment(`a${i}`, [{ s: 'strong', t: a.author }, { s: tone === 'muted' ? 'muted' : tone, t: ` ${verb}` }], a.at, now, a.body, a.url, links))
    } else if (a.kind === 'thread') {
      out.push(thread(a, `a${i}`, now, links))
    } else {
      out.push(comment(`a${i}`, [{ s: 'strong', t: a.author }, { s: 'muted', t: ' commented' }], a.at, now, a.body, a.url, links))
    }
  })

  flush()

  return out
}

function comment(key: string, who: SpanData[], at: string, now: number, body: string, url: string | undefined, links: BodyLinks, empty?: string): JSX.Element {
  return (
    <card head={[...who, { s: 'dim', t: ` · ${relative(at, now)}` }]} key={key} role="hermes.pr.comment">
      {bodyNodes(body, 'b', empty, links)}
      {url ? (
        <text key="link" role="hermes.pr.permalink" spans={[{ href: url, s: 'dim', t: 'View on GitHub' }]} wrap="none" />
      ) : null}
    </card>
  )
}

function thread(a: ActivityItem, key: string, now: number, links: BodyLinks): JSX.Element {
  const where = `${a.path ?? ''}${a.line ? `:${a.line}` : ''}`

  return (
    <card
      collapsed={Boolean(a.resolved || a.outdated)}
      collapsible
      head={[
        { s: 'strong', t: a.author },
        { s: 'muted', t: ' commented on ' },
        { s: 'mono', t: where },
        { s: 'dim', t: ` · ${relative(a.at, now)}` },
        ...(a.resolved ? [{ s: 'success', t: '  resolved' }] : []),
        ...(a.outdated ? [{ s: 'dim', t: '  outdated' }] : [])
      ]}
      key={key}
      role="hermes.pr.thread"
    >
      {bodyNodes(a.body, 'b', undefined, links)}
      {(a.replies ?? []).map((r, j) => (
        <col gap="xs" key={`r${j}`} role="hermes.pr.reply">
          <text key="h" spans={[{ s: 'strong', t: r.author }, { s: 'dim', t: ` · ${relative(r.at, now)}` }]} />
          {bodyNodes(r.body, 'b', undefined, links)}
        </col>
      ))}
      {a.url ? <text key="link" role="hermes.pr.permalink" spans={[{ href: a.url, s: 'dim', t: 'View on GitHub' }]} wrap="none" /> : null}
    </card>
  )
}

function commitRun(commits: ActivityItem[], key: string, now: number): JSX.Element {
  const authors = [...new Set(commits.map(c => c.author))]

  return (
    <col gap="xs" key={key} role="hermes.pr.commits">
      <row align="center" gap="sm" key="h">
        <icon key="i" name="commit" />
        <text
          key="t"
          spans={[
            { s: 'strong', t: authors.join(', ') },
            { s: 'muted', t: ` added ${plural(commits.length, 'commit')}` },
            { s: 'dim', t: ` · ${relative(commits.at(-1)!.at, now)}` }
          ]}
        />
      </row>
      {commits.map((c, i) => {
        const sha = c.url?.match(/\/commit\/([0-9a-f]{7})/)?.[1]

        return (
          <row align="center" gap="sm" key={`c${i}`} role="hermes.pr.commit">
            <text grow={1} key="m" spans={[{ t: c.body.split('\n')[0] ?? '' }]} truncate="end" wrap="none" />
            {sha ? <text key="s" spans={[{ href: c.url, s: 'mono dim', t: sha }]} wrap="none" /> : null}
          </row>
        )
      })}
    </col>
  )
}

// ── Checks ────────────────────────────────────────────────────────────────────────────────────

function took(c: Check, now: number): string {
  return c.startedAt && c.completedAt
    ? durationWhole(Date.parse(c.completedAt) - Date.parse(c.startedAt))
    : c.startedAt && c.status === 'pending'
      ? `${durationWhole(now - Date.parse(c.startedAt))}…`
      : ''
}

/** The checks in four folds: failing and running open, passed and skipped folded. */
function checksTab(pr: PullRequest, now: number): JSX.Element[] {
  if (!pr.checks.length) {
    return [<text key="none" spans={[{ s: 'muted', t: 'No checks ran on the latest commit.' }]} />]
  }

  const sorted = [...pr.checks].sort((a, b) => a.name.localeCompare(b.name))
  const groups: { id: string; head: string; open: boolean; checks: Check[] }[] = [
    { checks: sorted.filter(c => checkGroup(c) === 'attention'), head: 'Needs attention', id: 'bad', open: true },
    { checks: sorted.filter(c => checkGroup(c) === 'running'), head: 'Running', id: 'run', open: true },
    { checks: sorted.filter(c => c.status === 'success'), head: 'Passed', id: 'ok', open: false },
    { checks: sorted.filter(c => c.status === 'skipped' || c.status === 'neutral'), head: 'Skipped', id: 'skip', open: false }
  ]
  const runs = failedRuns(pr.checks).length

  return [
    <text
      key="sum"
      spans={[
        { s: checksTone(pr), t: checksSummary(pr.checks) },
        { s: 'dim', t: ` · on ${pr.headOid.slice(0, 7)}${runs ? ` · F re-runs ${plural(runs, 'failed workflow run')}` : ''}` }
      ]}
    />,
    ...groups
      .filter(g => g.checks.length)
      .map(g => (
        <section collapsed={!g.open} collapsible head={`${g.head} · ${g.checks.length}`} key={g.id} role="hermes.pr.checkgroup">
          {g.checks.map((c, i) => (
            <row align="center" gap="sm" key={`k${i}`} role="hermes.pr.check" title={c.description}>
              <icon key="i" name={CHECK[c.status].icon} tone={CHECK[c.status].tone} />
              <text grow={1} key="n" spans={[{ href: c.url, t: c.name }]} truncate="end" wrap="none" />
              {c.workflow && !c.name.startsWith(`${c.workflow} /`) ? <text key="w" spans={[{ s: 'dim', t: c.workflow }]} truncate="end" wrap="none" /> : null}
              <text key="s" spans={[{ s: CHECK[c.status].tone === 'muted' ? 'dim' : CHECK[c.status].tone, t: CHECK[c.status].word }]} wrap="none" />
              <text key="t" spans={[{ s: 'dim mono', t: took(c, now) }]} wrap="none" />
            </row>
          ))}
        </section>
      ))
  ]
}
