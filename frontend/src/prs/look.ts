// How a pull request reads at a glance: its state's word and tone, its checks' tone and icon,
// and the dot a list gives it. The view, the PR pill and the sidebar share them.

import type { Tone } from '@stencil-hq/tern'

import { checksState, type PullRequest } from '../github/pullRequest.js'
import type { Entry } from '../github/store.js'

/** Draft, Open, Merged or Closed. */
export function stateLabel(pr: PullRequest): string {
  return pr.state === 'open' ? (pr.draft ? 'Draft' : 'Open') : pr.state === 'merged' ? 'Merged' : 'Closed'
}

/** The tone of a PR's state. */
export function stateTone(pr: PullRequest): Tone {
  return pr.state === 'merged' ? 'accent' : pr.state === 'closed' ? 'error' : pr.draft ? 'muted' : 'success'
}

/** The tone of a PR's checks. */
export function checksTone(pr: PullRequest): Tone {
  const s = checksState(pr.checks)

  return s === 'failing' ? 'error' : s === 'pending' ? 'warning' : s === 'passing' ? 'success' : 'muted'
}

/** The dot of a PR in a list: its checks while open, else its state. */
export function prTone(e: Entry): Tone {
  return e.pr ? (e.pr.state === 'open' && e.pr.checks.length ? checksTone(e.pr) : stateTone(e.pr)) : 'muted'
}

/** The icon of a PR's checks: failed, running, passed, or none reported. */
export function checksIcon(pr: PullRequest): string {
  const s = checksState(pr.checks)

  return s === 'failing' ? 'failed' : s === 'pending' ? 'running' : s === 'passing' ? 'success' : 'info'
}
