// The Pull requests sheet (`/prs`, ⌥P, the PR pill): the PRs the agent linked to this
// conversation, read from GitHub, in the picker T3 Code's PR panel became. Four tabs, each a list
// with its preview: PRs (the overview of each), and for the selected PR its Checks, its Activity
// (comments, reviews, review threads, commits) and its Files (each diff). Enter on a PR opens its
// checks; on a check, comment or file it opens that on GitHub. O opens the PR on GitHub, C copies
// its URL, M merges, X closes (both ask first), D marks it ready, U updates its branch, F re-runs
// its failed jobs, Shift+R reads GitHub again.

import { execFile } from 'node:child_process'

import type { JSX, Key, PickerColumn, PickerItem, Span } from '@stencil-hq/tern'

import type { App } from '../app.js'
import { copyToClipboard } from '../clipboard.js'
import { prKey } from '../github/links.js'
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
import type { Entry, PrAction } from '../github/store.js'
import type { Overlay } from '../overlay.js'
import { relative } from '../processes/cron.js'
import type { PrsPill } from '../view/dock.js'

import { moveSelection } from './search.js'

const KEY = 'pull-requests'
const TICK_MS = 30_000
const COPIED_MS = 1500

type Tab = 'activity' | 'checks' | 'files' | 'prs'

const TABS: Tab[] = ['prs', 'checks', 'activity', 'files']

type Tone = 'accent' | 'error' | 'info' | 'muted' | 'pending' | 'success' | 'warning'

const METHOD_LABEL: Record<MergeMethod, string> = { merge: 'Merge', rebase: 'Rebase and merge', squash: 'Squash and merge' }

/** Opens `url` in the default browser on this machine. */
export function openUrl(url: string) {
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => {})
}

export function stateLabel(pr: PullRequest): string {
  return pr.state === 'open' ? (pr.draft ? 'Draft' : 'Open') : pr.state === 'merged' ? 'Merged' : 'Closed'
}

export function stateTone(pr: PullRequest): Tone {
  return pr.state === 'merged' ? 'info' : pr.state === 'closed' ? 'error' : pr.draft ? 'muted' : 'success'
}

const CHECK_TONE: Record<Check['status'], Tone> = {
  'action-required': 'warning',
  cancelled: 'muted',
  failure: 'error',
  neutral: 'muted',
  pending: 'pending',
  skipped: 'muted',
  success: 'success'
}

const CHECK_WORD: Record<Check['status'], string> = {
  'action-required': 'waiting for approval',
  cancelled: 'cancelled',
  failure: 'failed',
  neutral: 'neutral',
  pending: 'running',
  skipped: 'skipped',
  success: 'passed'
}

export function checksTone(pr: PullRequest): Tone {
  const s = checksState(pr.checks)

  return s === 'failing' ? 'error' : s === 'pending' ? 'pending' : s === 'passing' ? 'success' : 'muted'
}

const REVIEW: Record<string, [string, Tone]> = {
  APPROVED: ['Approved', 'success'],
  CHANGES_REQUESTED: ['Changes requested', 'error'],
  COMMENTED: ['Commented', 'muted'],
  DISMISSED: ['Dismissed', 'muted'],
  REVIEW_REQUIRED: ['Review required', 'warning']
}

const FILE_TONE: Record<string, Tone> = { added: 'success', removed: 'error', renamed: 'info' }

/** Opens the sheet, on PR `focus` (a key) when given. */
export function openPullRequests(app: App, focus?: string) {
  const newest = app.prs.entries().at(-1)
  let selected = focus ?? (newest ? prKey(newest.ref) : undefined)
  let tab: Tab = 'prs'
  /** The selected row of each of the selected PR's tabs. */
  const rows: Partial<Record<Tab, string>> = {}
  let confirm: 'close' | 'merge' | undefined
  let copied: string | undefined
  let copiedTimer: NodeJS.Timeout | undefined

  app.prs.poke()

  const timer = setInterval(() => (app.overlays.includes(overlay) ? app.changed() : end()), TICK_MS)

  function end() {
    clearInterval(timer)
    clearTimeout(copiedTimer)
  }

  const close = () => {
    end()
    app.close(overlay)
  }

  const current = (): Entry | undefined => (selected ? app.prs.get(selected) : undefined)

  const fail = (error: unknown) => {
    app.transcript.notice(error instanceof Error ? error.message : String(error), 'error')
    app.changed()
  }

  /**
   * Reads what the tab lists, once per PR update. Asked on every frame, so a PR that loads late, a
   * newer PR or a failed read (its error shows in the tab) is read without leaving the tab.
   */
  const load = () => {
    if (!current()?.pr) {
      return
    }

    if (tab === 'activity') {
      app.prs.activity(selected!).catch(() => {})
    } else if (tab === 'files') {
      app.prs.files(selected!).catch(() => {})
    }
  }

  const setTab = (t: Tab) => {
    tab = t
    confirm = undefined
    load()
  }

  const act = async (action: PrAction) => {
    confirm = undefined

    if (!current()?.pr || app.prs.busy(selected!)) {
      return app.changed()
    }

    try {
      await app.prs.act(action, selected!)
    } catch (error) {
      fail(error)
    }

    app.changed()
  }

  const copy = () => {
    const e = current()

    if (!e) {
      return
    }

    copyToClipboard(e.pr?.url ?? e.ref.url)
    copied = selected
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      copied = undefined
      app.changed()
    }, COPIED_MS)
  }

  /** What may be done to the selected PR now. */
  const can = (action: PrAction): boolean => {
    const pr = current()?.pr

    if (!pr || app.prs.busy(selected!)) {
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

  const ask = (what: 'close' | 'merge') => {
    if (can(what)) {
      confirm = what
    }
  }

  const openPr = () => {
    const e = current()

    if (e) {
      openUrl(e.pr?.url ?? e.ref.url)
    }
  }

  /** Enter (or a second click): a PR shows its checks; a check, comment or file opens on GitHub. */
  const activate = () => {
    if (tab === 'prs') {
      return current() && setTab('checks')
    }

    const url = rowUrl(tab, current(), rows[tab])

    if (url) {
      openUrl(url)
    }
  }

  const overlay: Overlay = {
    key: KEY,
    modal: true,
    node: () => sheetNode(Date.now()),
    onKey: (k: Key) => {
      if (confirm) {
        if (k.name === 'enter' || k.name === 'y') {
          void act(confirm)
        } else if (k.name === 'escape' || k.name === 'n') {
          confirm = undefined
        }

        return true
      }

      const bare = !k.ctrl && !k.alt && !k.meta

      if (k.name === 'escape') {
        if (tab === 'prs') {
          close()
        } else {
          setTab('prs')
        }
      } else if (k.name === 'enter') {
        activate()
      } else if (k.name === 'tab') {
        setTab(TABS[(TABS.indexOf(tab) + (k.shift ? TABS.length - 1 : 1)) % TABS.length]!)
      } else if (bare && k.name === 'o') {
        openPr()
      } else if (bare && k.name === 'c' && !k.shift) {
        copy()
      } else if (bare && k.name === 'm') {
        ask('merge')
      } else if (bare && k.name === 'x') {
        ask('close')
      } else if (bare && k.name === 'd' && can('ready')) {
        void act('ready')
      } else if (bare && k.name === 'u' && can('update-branch')) {
        void act('update-branch')
      } else if (bare && k.name === 'f' && can('rerun')) {
        void act('rerun')
      } else if (bare && k.name === 'r' && k.shift) {
        app.prs.poke()
      } else if (tab === 'prs') {
        selected = moveSelection(k, prKeys(), selected) ?? selected
      } else {
        rows[tab] = moveSelection(k, rowIds(tab, current()), rows[tab]) ?? rows[tab]
      }

      return true
    }
  }

  const prKeys = () => prOrder(app.prs.entries()).flatMap(o => (typeof o === 'string' ? [o] : []))

  const handlers = {
    activate,
    cancel: () => {
      confirm = undefined
      app.changed()
    },
    close: () => {
      if (tab === 'prs') {
        close()
      } else {
        setTab('prs')
        app.changed()
      }
    },
    'close-pr': () => {
      ask('close')
      app.changed()
    },
    confirm: () => void (confirm && act(confirm)),
    copy: () => {
      copy()
      app.changed()
    },
    merge: () => {
      ask('merge')
      app.changed()
    },
    open: openPr,
    ready: () => void act('ready'),
    refresh: () => app.prs.poke(),
    reopen: () => void act('reopen'),
    rerun: () => void act('rerun'),
    tab: (ev: { value?: string }) => {
      setTab(TABS.find(t => t === ev.value) ?? 'prs')
      app.changed()
    },
    'update-branch': () => void act('update-branch')
  }

  function sheetNode(now: number): JSX.Element {
    const entries = app.prs.entries()
    const keys = prKeys()

    if (!selected || !keys.includes(selected)) {
      selected = keys[0]
    }

    load()

    const e = current()
    const pr = e?.pr
    const busy = selected ? app.prs.busy(selected) : false
    const method = pr?.mergeMethods[0] ?? 'merge'
    const ids = rowIds(tab, e)

    const row = rows[tab]

    if (tab !== 'prs' && (!row || !ids.includes(row))) {
      rows[tab] = ids[0]
    }

    const view = tabView(tab, e, now)
    const preview =
      tab === 'activity'
        ? activityPreview(e?.activity?.[Number(rows.activity?.slice(1))], now)
        : tab === 'files'
          ? filePreview(e?.files?.find(f => f.path === rows.files))
          : view.preview

    return (
      <picker
        actions={[
          ...(can('ready') ? [{ id: 'ready', keys: ['d'], label: 'Ready for review' }] : []),
          ...(can('update-branch') ? [{ id: 'update-branch', keys: ['u'], label: 'Update branch' }] : []),
          ...(can('rerun') ? [{ id: 'rerun', keys: ['f'], label: 'Re-run failed' }] : []),
          ...(can('close') ? [{ danger: true, id: 'close-pr', keys: ['x'], label: 'Close PR' }] : []),
          ...(can('reopen') ? [{ id: 'reopen', label: 'Reopen' }] : []),
          { disabled: e ? undefined : 'No pull request', id: 'copy', keys: ['c'], label: copied && copied === selected ? 'Copied' : 'Copy URL' },
          { disabled: e ? undefined : 'No pull request', id: 'open', keys: ['o'], label: 'Open on GitHub' },
          ...(can('merge') ? [{ id: 'merge', keys: ['m'], label: busy ? 'Working…' : METHOD_LABEL[method] }] : []),
          { end: true, id: 'close', keys: ['esc'], label: tab === 'prs' ? 'Close' : 'Back' },
          ...(tab === 'prs'
            ? [{ disabled: e ? undefined : 'No pull request', id: 'activate', keys: ['enter'], label: 'Checks', primary: true }]
            : rowUrl(tab, e, rows[tab])
              ? [{ id: 'activate', keys: ['enter'], label: 'Open', primary: true }]
              : [])
        ]}
        columns={view.columns}
        confirm={
          confirm === 'merge' && pr
            ? { act: 'confirm', label: METHOD_LABEL[method], text: `${METHOD_LABEL[method]} #${pr.number} into ${pr.base}?` }
            : confirm === 'close' && pr
              ? { act: 'confirm', label: 'Close PR', text: `Close #${pr.number} without merging?` }
              : undefined
        }
        empty={view.empty}
        icon="merge"
        items={tab === 'prs' ? entries.map(x => prItem(x, now)) : view.items}
        key={KEY}
        layout={tab === 'activity' ? 'timeline' : 'rows'}
        message={app.prs.error ?? view.error}
        noun={view.noun}
        onAction={handlers}
        onActivate={ev => {
          if (tab === 'prs') {
            selected = ev.item
          } else {
            rows[tab] = ev.item
          }

          activate()
          app.changed()
        }}
        onSelect={ev => {
          if (tab === 'prs') {
            selected = ev.item
          } else {
            rows[tab] = ev.item
          }

          confirm = undefined
          app.changed()
        }}
        order={tab === 'prs' ? prOrder(entries) : ids}
        preview={tab === 'files' || tab === 'activity' ? 'below' : 'side'}
        selected={tab === 'prs' ? selected : rows[tab]}
        size="lg"
        state={app.prs.error || view.error ? 'error' : view.loading ? 'loading' : 'ready'}
        subtitle={[{ s: 'muted', t: tab === 'prs' ? summary(entries) : pr ? `#${pr.number} ${pr.title}` : '' }]}
        tab={tab}
        tabs={[
          { count: entries.length, id: 'prs', label: 'PRs' },
          { count: pr?.checks.length, id: 'checks', label: 'Checks' },
          { count: e?.activity?.length, id: 'activity', label: 'Activity' },
          { count: pr?.changedFiles, id: 'files', label: 'Files' }
        ]}
        title="Pull requests"
        total={tab === 'prs' ? entries.length : ids.length}
      >
        {preview}
      </picker>
    )
  }

  app.open(overlay)
}

interface TabView {
  columns: PickerColumn[]
  items: PickerItem[]
  preview: JSX.Element[] | null
  empty: string
  noun: string
  loading: boolean
  /** Why the tab's list could not be read. */
  error?: string
}

/** The ids a tab lists for PR `e`, in order. */
function rowIds(tab: Tab, e: Entry | undefined): string[] {
  switch (tab) {
    case 'checks':
      return sortedChecks(e?.pr?.checks ?? []).map(c => c.name)

    case 'activity':
      return (e?.activity ?? []).map((_, i) => `a${i}`).toReversed()

    case 'files':
      return (e?.files ?? []).map(f => f.path)

    default:
      return []
  }
}

function rowUrl(tab: Tab, e: Entry | undefined, row: string | undefined): string | undefined {
  if (!e || !row) {
    return undefined
  }

  switch (tab) {
    case 'checks':
      return e.pr?.checks.find(c => c.name === row)?.url

    case 'activity':
      return e.activity?.[Number(row.slice(1))]?.url || undefined

    case 'files':
      return e.pr ? `${e.pr.url}/files` : undefined

    default:
      return undefined
  }
}

export function tabView(tab: Tab, e: Entry | undefined, now: number): TabView {
  const pr = e?.pr

  switch (tab) {
    case 'checks':
      return {
        columns: [
          { format: 'dim', head: 'Status', id: 'status', priority: 3 },
          { format: 'dim', head: 'Time', id: 'time', priority: 2 }
        ],
        empty: pr ? 'No checks ran on the latest commit.' : 'Pick a pull request first.',
        items: sortedChecks(pr?.checks ?? []).map(c => checkItem(c, now)),
        loading: false,
        noun: 'checks',
        preview: pr ? checksPreview(pr) : null
      }

    case 'activity':
      return {
        columns: [{ format: 'dim', head: 'When', id: 'when', priority: 2 }],
        empty: pr ? 'No comments, reviews or commits yet.' : 'Pick a pull request first.',
        // A failed read with nothing to show says why; an older list stays up while it is tried again.
        error: pr && !e?.activity ? e?.activityError : undefined,
        items: (e?.activity ?? []).map((a, i) => activityItem(a, `a${i}`, now)),
        loading: Boolean(pr && !e?.activity && !e?.activityError),
        noun: 'events',
        preview: null
      }

    case 'files':
      return {
        columns: [{ format: 'dim', head: 'Changes', id: 'changes', priority: 2 }],
        empty: pr ? 'No files changed.' : 'Pick a pull request first.',
        error: pr && !e?.files ? e?.filesError : undefined,
        items: (e?.files ?? []).map(fileItem),
        loading: Boolean(pr && !e?.files && !e?.filesError),
        noun: 'files',
        preview: null
      }

    default:
      return {
        columns: [
          { format: 'dim', head: 'Checks', id: 'checks', min: 10, priority: 3 },
          { format: 'dim', head: 'Review', id: 'review', priority: 2 },
          { format: 'dim', head: 'Updated', id: 'updated', priority: 1 }
        ],
        empty: 'No pull requests linked yet. Hermes links each PR it opens or works on.',
        items: [],
        loading: false,
        noun: 'pull requests',
        preview: e ? overview(e, now) : null
      }
  }
}

/** Failures first, then running, then the rest; by name within each. */
function sortedChecks(checks: readonly Check[]): Check[] {
  const rank = { attention: 0, completed: 2, running: 1 }

  return [...checks].sort((a, b) => rank[checkGroup(a)] - rank[checkGroup(b)] || a.name.localeCompare(b.name))
}

function summary(entries: Entry[]): string {
  const prs = entries.flatMap(e => (e.pr ? [e.pr] : []))
  const parts: [number, string][] = [
    [prs.filter(p => p.state === 'open' && !p.draft).length, 'open'],
    [prs.filter(p => p.state === 'open' && p.draft).length, 'draft'],
    [prs.filter(p => p.state === 'merged').length, 'merged'],
    [prs.filter(p => p.state === 'closed').length, 'closed']
  ]

  return (
    parts
      .filter(([n]) => n)
      .map(([n, l]) => `${n} ${l}`)
      .join(' · ') || (entries.length ? 'loading…' : 'none yet')
  )
}

/**
 * The PRs tab's rows: newest first, except that the layers of a stack sit together under a header,
 * top layer first, as T3 Code lists a chain.
 */
export function prOrder(entries: Entry[]): (string | { group: string; label: string; count?: number })[] {
  const stacks = [...new Set(entries.flatMap(e => (e.stack ? [e.stack] : [])))]

  if (!stacks.length) {
    return entries.map(e => prKey(e.ref)).toReversed()
  }

  const rest = entries.filter(e => !e.stack).toReversed()

  return [
    ...stacks.flatMap(s => {
      const layers = s.layers
        .map(l => entries.find(e => e.ref.number === l.number && e.stack === s))
        .filter((e): e is Entry => Boolean(e))
        .toReversed()

      return [{ count: s.layers.length, group: s.key, label: `Stack on ${s.base || 'its base'}` }, ...layers.map(e => prKey(e.ref))]
    }),
    ...(rest.length ? [{ group: 'prs', label: 'Pull requests' }, ...rest.map(e => prKey(e.ref))] : [])
  ]
}

function prItem(e: Entry, now: number): PickerItem {
  const pr = e.pr
  const review = pr?.reviewDecision ? REVIEW[pr.reviewDecision] : undefined
  const layer = e.stack ? e.stack.layers.findIndex(l => l.number === e.ref.number) + 1 : 0

  return {
    badges: pr
      ? [
          { text: stateLabel(pr), tone: stateTone(pr) },
          ...(e.source === 'branch' ? [{ text: 'this branch', title: 'The PR of the session’s branch; Hermes did not link it', tone: 'accent' as const }] : []),
          ...(pr.mergeable === 'conflicting' && pr.state === 'open' ? [{ text: 'conflicts', tone: 'error' as const }] : [])
        ]
      : e.error
        ? [{ text: 'unreadable', title: e.error, tone: 'error' as const }]
        : [],
    detail: `${e.ref.repository} #${e.ref.number}${layer ? ` · layer ${layer} of ${e.stack!.layers.length}` : ''}`,
    dot: pr ? (pr.state === 'open' ? checksTone(pr) : stateTone(pr)) : 'muted',
    facts: pr
      ? {
          checks: pr.checks.length ? [{ s: checksTone(pr), t: checksState(pr.checks) }] : 'none',
          review: review?.[0] ?? '',
          updated: relative(pr.updatedAt, now)
        }
      : {},
    id: prKey(e.ref),
    label: pr?.title ?? `#${e.ref.number}`,
    title: e.error ?? pr?.url ?? e.ref.url,
    tone: pr && pr.state !== 'open' ? 'muted' : undefined
  }
}

// ── PRs: the overview ─────────────────────────────────────────────────────────────────────────

function header(e: Entry): JSX.Element[] {
  const pr = e.pr

  return [
    <text key="title" role="omp.hub.title" text={pr?.title ?? `#${e.ref.number}`} />,
    <row align="center" gap="sm" key="sub" wrap>
      {pr ? <badge key="state" text={stateLabel(pr)} tone={stateTone(pr)} /> : null}
      <text key="ref" spans={[{ href: pr?.url ?? e.ref.url, s: 'dim', t: `${e.ref.repository}#${e.ref.number}` }]} wrap="none" />
    </row>,
    ...(pr
      ? [
          <text
            key="branch"
            spans={[{ s: 'muted', t: `${pr.author} · ` }, { s: 'mono', t: pr.head }, { s: 'muted', t: ' → ' }, { s: 'mono', t: pr.base }]}
            truncate="end"
            wrap="none"
          />
        ]
      : [])
  ]
}

function facts(pr: PullRequest, now: number): { k: Span[]; v: Span[] | string }[] {
  const review = pr.reviewDecision ? REVIEW[pr.reviewDecision] : undefined
  const merge: Span[] | string | undefined =
    pr.state !== 'open'
      ? undefined
      : pr.mergeable === 'conflicting'
        ? [{ s: 'error', t: 'Conflicts with the base branch' }]
        : pr.behindBy
          ? [{ s: 'warning', t: `${pr.behindBy} commit${pr.behindBy === 1 ? '' : 's'} behind ${pr.base}` }]
          : pr.mergeable === 'mergeable'
            ? [{ s: 'success', t: 'No conflicts' }]
            : 'Checking…'

  return [
    { k: [{ t: 'Checks' }], v: [{ s: checksTone(pr), t: checksSummary(pr.checks) }] },
    ...(review ? [{ k: [{ t: 'Review' }], v: [{ s: review[1], t: review[0] }] as Span[] }] : []),
    ...(merge ? [{ k: [{ t: 'Merge' }], v: merge }] : []),
    ...(pr.autoMerge ? [{ k: [{ t: 'Auto-merge' }], v: `on (${pr.autoMerge.toLowerCase()})` }] : []),
    {
      k: [{ t: 'Changes' }],
      v: [
        { s: 'success', t: `+${pr.additions}` },
        { t: ' ' },
        { s: 'error', t: `−${pr.deletions}` },
        { s: 'muted', t: ` in ${pr.changedFiles} file${pr.changedFiles === 1 ? '' : 's'}` }
      ]
    },
    ...(pr.reviewers.length ? [{ k: [{ t: 'Reviewers' }], v: pr.reviewers.map(r => `${r.login} ${reviewWord(r.state)}`).join(', ') }] : []),
    ...(pr.labels.length ? [{ k: [{ t: 'Labels' }], v: pr.labels.join(', ') }] : []),
    ...(pr.mergedAt
      ? [{ k: [{ t: 'Merged' }], v: relative(pr.mergedAt, now) }]
      : pr.closedAt
        ? [{ k: [{ t: 'Closed' }], v: relative(pr.closedAt, now) }]
        : [{ k: [{ t: 'Opened' }], v: relative(pr.createdAt, now) }]),
    { k: [{ t: 'Updated' }], v: relative(pr.updatedAt, now) }
  ]
}

function reviewWord(state: string): string {
  return state === 'PENDING' ? '(requested)' : `(${(REVIEW[state]?.[0] ?? 'commented').toLowerCase()})`
}

function overview(e: Entry, now: number): JSX.Element[] {
  const pr = e.pr

  if (!pr) {
    return [...header(e), <text key="state" spans={[{ s: e.error ? 'error' : 'muted', t: e.error ?? 'Reading GitHub…' }]} />]
  }

  const SOURCE = { branch: 'The PR of this session’s branch', linked: 'Linked by Hermes', stack: 'A layer of the stack' }

  return [
    ...header(e),
    <kv items={[...facts(pr, now), { k: [{ t: 'Shown because' }], v: SOURCE[e.source] }]} key="facts" role="omp.hub.kv" />,
    ...(e.stack
      ? [
          <section head={`Stack · ${e.stack.layers.length} layers on ${e.stack.base}`} key="stack">
            {e.stack.layers.toReversed().map(l => (
              <text
                key={`l${l.number}`}
                spans={[
                  { s: l.number === e.ref.number ? 'strong' : undefined, t: `#${l.number} ` },
                  { s: 'mono dim', t: l.head },
                  { s: l.state === 'merged' ? 'info' : l.state === 'closed' ? 'error' : 'muted', t: ` · ${l.state}` }
                ]}
                truncate="end"
                wrap="none"
              />
            ))}
          </section>
        ]
      : []),
    <section head="Description" key="body">
      <md key="text" text={pr.body.trim() || '_No description._'} />
    </section>
  ]
}

// ── Checks ────────────────────────────────────────────────────────────────────────────────────

function took(c: Check, now: number): string {
  return c.startedAt && c.completedAt
    ? duration(Date.parse(c.completedAt) - Date.parse(c.startedAt))
    : c.startedAt && c.status === 'pending'
      ? `${duration(now - Date.parse(c.startedAt))}…`
      : ''
}

function checkItem(c: Check, now: number): PickerItem {
  return {
    detail: c.workflow && !c.name.startsWith(`${c.workflow} /`) ? c.workflow : c.description,
    dot: CHECK_TONE[c.status],
    facts: { status: [{ s: CHECK_TONE[c.status], t: CHECK_WORD[c.status] }], time: took(c, now) },
    id: c.name,
    label: c.name,
    title: c.url,
    tone: c.status === 'skipped' || c.status === 'neutral' ? 'muted' : undefined
  }
}

function checksPreview(pr: PullRequest): JSX.Element[] {
  const runs = failedRuns(pr.checks).length

  return [
    <text key="title" role="omp.hub.title" text="Checks" />,
    <text key="sum" spans={[{ s: checksTone(pr), t: checksSummary(pr.checks) }]} />,
    <text
      key="hint"
      spans={[
        {
          s: 'muted',
          t: `On ${pr.head} at ${pr.headOid.slice(0, 7)}. Enter opens a check's log${runs ? `; F re-runs the failed jobs of ${runs} workflow run${runs === 1 ? '' : 's'}` : ''}.`
        }
      ]}
    />
  ]
}

// ── Activity ──────────────────────────────────────────────────────────────────────────────────

const VERB: Record<ActivityItem['kind'], string> = { comment: 'commented', commit: 'pushed', review: 'reviewed', thread: 'commented on' }

function activityItem(a: ActivityItem, id: string, now: number): PickerItem {
  const verdict = a.kind === 'review' && a.state ? REVIEW[a.state] : undefined
  const words = a.kind === 'commit' ? a.body : a.body.replace(/\s+/g, ' ').trim()

  return {
    badges: [
      ...(verdict && a.state !== 'COMMENTED' ? [{ text: verdict[0].toLowerCase(), tone: verdict[1] }] : []),
      ...(a.resolved ? [{ text: 'resolved', tone: 'success' as const }] : []),
      ...(a.outdated ? [{ text: 'outdated' }] : [])
    ],
    detail: a.kind === 'thread' && a.path ? `${a.path}${a.line ? `:${a.line}` : ''}${words ? ` · ${words}` : ''}` : words,
    facts: { when: relative(a.at, now) },
    id,
    label: [{ s: 'strong', t: a.author }, { s: 'muted', t: ` ${verdict && a.state !== 'COMMENTED' ? 'reviewed' : VERB[a.kind]}` }],
    node: a.kind === 'commit' ? 'tool' : a.kind === 'review' ? 'user' : undefined,
    title: a.url
  }
}

/** The selected event in full: its words, and a thread's replies. */
function activityPreview(a: ActivityItem | undefined, now: number): JSX.Element[] | null {
  if (!a) {
    return null
  }

  return [
    <text key="h" spans={[{ s: 'strong', t: a.author }, { s: 'muted', t: ` ${VERB[a.kind]}` }, { s: 'dim', t: ` · ${relative(a.at, now)}` }]} />,
    ...(a.kind === 'thread' && a.path ? [<text key="p" spans={[{ s: 'mono dim', t: `${a.path}${a.line ? `:${a.line}` : ''}` }]} />] : []),
    a.body.trim() ? <md key="b" text={a.body} /> : <text key="b" spans={[{ s: 'muted', t: 'No words.' }]} />,
    ...(a.replies ?? []).map((r, j) => (
      <col gap="xs" key={`r${j}`} role="hermes.pr.reply">
        <text key="h" spans={[{ s: 'strong', t: r.author }, { s: 'dim', t: ` · ${relative(r.at, now)}` }]} />
        <md key="b" text={r.body} />
      </col>
    ))
  ]
}

// ── Files ─────────────────────────────────────────────────────────────────────────────────────

function fileItem(f: PrFile): PickerItem {
  return {
    badges: f.status !== 'modified' ? [{ text: f.status, tone: FILE_TONE[f.status] }] : [],
    detail: f.previous ? `from ${f.previous}` : undefined,
    facts: { changes: [{ s: 'success', t: `+${f.additions}` }, { t: ' ' }, { s: 'error', t: `−${f.deletions}` }] },
    id: f.path,
    label: f.path,
    mono: true
  }
}

function filePreview(f: PrFile | undefined): JSX.Element[] | null {
  if (!f) {
    return null
  }

  return f.patch
    ? [<diff key={`d:${f.path}`} path={f.path} text={f.patch} />]
    : [<text key="none" spans={[{ s: 'muted', t: 'Binary, or too large to show here. Enter opens it on GitHub.' }]} />]
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))

  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** The PR pill: the newest linked PR (`#22 · checks passing`), or how many there are. */
export function prsPill(entries: Entry[], onOpen: () => void): PrsPill | undefined {
  const newest = entries.at(-1)

  if (!newest) {
    return undefined
  }

  const open = entries.flatMap(e => (e.pr?.state === 'open' ? [e.pr] : []))
  const pr = newest.pr

  if (entries.length === 1) {
    const what = !pr
      ? ''
      : pr.state !== 'open'
        ? stateLabel(pr).toLowerCase()
        : pr.checks.length
          ? `checks ${checksState(pr.checks)}`
          : stateLabel(pr).toLowerCase()

    return { onOpen, text: `#${newest.ref.number}${what ? ` · ${what}` : ''}`, tone: pr ? (pr.state === 'open' ? checksTone(pr) : stateTone(pr)) : 'muted' }
  }

  const failing = open.some(p => checksState(p.checks) === 'failing')
  const pending = open.some(p => checksState(p.checks) === 'pending')

  return {
    onOpen,
    text: `${entries.length} PRs${open.length ? ` · ${open.length} open` : ''}`,
    tone: failing ? 'error' : pending ? 'pending' : open.length ? 'success' : 'muted'
  }
}
