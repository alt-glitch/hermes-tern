// The session sidebar (⌥S, `/sidebar`): Tern's aside, a `prefs` sheet docked at the pane's right
// edge that narrows the chat beside it. It shows where the session works: the branch and how far it
// is from its upstream, the session's pull requests, and the changed files. It takes no keys; the
// composer keeps them. A PR opens in the PR aside (in its place); a file opens the Changes sheet on its diff.

import type { JSX, PrefsRow } from '@stencil-hq/tern'

import type { App } from './app.js'
import { copyToClipboard } from './clipboard.js'
import { type GitState, gitState } from './git/status.js'
import { prKey } from './github/links.js'
import { checksState } from './github/pullRequest.js'
import { openChanges } from './overlays/changes.js'
import { openPullRequests, stateLabel } from './overlays/pullRequests.js'

const POLL_MS = 5000
/** The sheet's actions: its close, and each row button's `act`. */
const ACTS = ['close', 'page', 'copy-branch', 'open-pr', 'diff', 'all-files'] as const
/** The sidebar lists this many changed files; the Changes sheet has them all. */
const MAX_FILES = 40

export class Sidebar {
  readonly #app: App
  #open = false
  #state: GitState | undefined
  #cwd: string | null = null
  #timer: NodeJS.Timeout | undefined
  #reading = false
  #copied = false
  #copiedTimer: NodeJS.Timeout | undefined

  constructor(app: App) {
    this.#app = app
  }

  get open(): boolean {
    return this.#open
  }

  get state(): GitState | undefined {
    return this.#state
  }

  toggle() {
    this.#open = !this.#open
    clearTimeout(this.#timer)

    if (this.#open) {
      void this.refresh()
    }

    this.#app.changed()
  }

  /** Reads git again now (a tool changed files, the turn ended). */
  poke() {
    if (this.#open) {
      void this.refresh()
    }
  }

  dispose() {
    this.#open = false
    clearTimeout(this.#timer)
  }

  async refresh() {
    const cwd = this.#app.info?.cwd || null

    if (this.#reading) {
      return
    }

    this.#reading = true
    clearTimeout(this.#timer)

    try {
      this.#state = cwd ? await gitState(cwd) : undefined
      this.#cwd = cwd
    } finally {
      this.#reading = false

      if (this.#open) {
        this.#timer = setTimeout(() => void this.refresh(), POLL_MS)
      }

      this.#app.changed()
    }
  }

  node(id: string): JSX.Element | null {
    if (!this.#open) {
      return null
    }

    const app = this.#app
    const git = this.#state
    const prs = app.prs.entries().toReversed()
    const files = git?.files ?? []
    const added = files.reduce((n, f) => n + f.additions, 0)
    const removed = files.reduce((n, f) => n + f.deletions, 0)
    const where = git?.upstream
      ? git.ahead || git.behind
        ? [git.ahead && `${git.ahead} ahead`, git.behind && `${git.behind} behind`].filter(Boolean).join(', ') + ` of ${git.upstream}`
        : `Up to date with ${git.upstream}`
      : 'Not pushed: no upstream'

    const branchRows: PrefsRow[] = git
      ? [
          {
            control: git.branch ? { act: 'copy-branch', k: 'action', label: this.#copied ? 'Copied' : 'Copy' } : undefined,
            hint: git.branch ? where : 'Detached HEAD',
            id: 'branch',
            label: git.branch ?? 'No branch'
          }
        ]
      : [{ disabled: this.#cwd ? 'This folder is not in a git repository.' : 'The session has no folder yet.', id: 'branch', label: 'No git' }]

    const prRows: PrefsRow[] = prs.length
      ? prs.map(e => ({
          control: { act: 'open-pr', k: 'action', label: 'Open' },
          hint: e.pr
            ? [
                stateLabel(e.pr),
                e.pr.checks.length ? `checks ${checksState(e.pr.checks)}` : '',
                e.source === 'branch' ? 'this branch' : e.source === 'stack' ? 'stack layer' : ''
              ]
                .filter(Boolean)
                .join(' · ')
            : (e.error ?? 'Reading GitHub…'),
          id: `pr:${prKey(e.ref)}`,
          label: `#${e.ref.number} ${e.pr?.title ?? e.ref.repository}`,
          warning: e.pr?.state === 'open' && e.pr.mergeable === 'conflicting' ? 'Conflicts with its base branch' : undefined
        }))
      : [{ disabled: 'Hermes links each PR it opens; the branch’s PR shows here too.', id: 'no-prs', label: 'None yet' }]

    const fileRows: PrefsRow[] = files.length
      ? files.slice(0, MAX_FILES).map(f => ({
          control: { act: 'diff', k: 'action', label: 'Diff' },
          hint: `${f.status}${f.staged ? ', staged' : ''} · +${f.additions} −${f.deletions}`,
          id: `file:${f.path}`,
          label: f.path
        }))
      : git
        ? [{ disabled: 'Nothing changed since the last commit.', id: 'no-files', label: 'Clean' }]
        : []

    return (
      <prefs
        key="sidebar"
        lead={git ? git.root.replace(process.env.HOME ?? '\u0000', '~') : (app.info?.cwd ?? '')}
        onAction={Object.fromEntries(ACTS.map(act => [act, (ev: { value?: unknown }) => this.#action(act, ev.value)]))}
        page="session"
        pages={[{ icon: 'branch', id: 'session', label: 'Session' }]}
        sections={[
          { id: 'branch', rows: branchRows, title: 'Branch' },
          { id: 'prs', rows: prRows, title: `Pull requests${prs.length ? ` · ${prs.length}` : ''}` },
          ...(fileRows.length
            ? [
                {
                  id: 'files',
                  rows: [
                    ...fileRows,
                    ...(files.length > MAX_FILES
                      ? [{ control: { act: 'all-files', k: 'action' as const, label: 'Show all' }, id: 'more', label: `${files.length - MAX_FILES} more` }]
                      : [])
                  ],
                  title: files.length ? `Changes · ${files.length} files · +${added} −${removed}` : 'Changes'
                }
              ]
            : [])
        ]}
        title="Session"
      />
    )
  }

  #action(act: string, value: unknown) {
    const row = typeof value === 'string' ? value : ''

    switch (act) {
      case 'close':
        // A row's `close` is an open menu closing; only the sheet's own close has no row.
        if (!row) {
          this.toggle()
        }

        return

      case 'copy-branch':
        if (this.#state?.branch) {
          copyToClipboard(this.#state.branch)
          this.#copied = true
          clearTimeout(this.#copiedTimer)
          this.#copiedTimer = setTimeout(() => {
            this.#copied = false
            this.#app.changed()
          }, 1500)
          this.#app.changed()
        }

        return

      case 'open-pr':
        return openPullRequests(this.#app, row.replace(/^pr:/, ''))

      case 'diff':
        return openChanges(this.#app, row.replace(/^file:/, ''))

      case 'all-files':
        return openChanges(this.#app)
    }
  }
}
