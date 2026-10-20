// The Checks tab of a pull request: the checks of its latest commit in four folds, failing and
// running open, passed and skipped folded, each with its workflow, its word and how long it took.

import type { JSX, Tone } from '@stencil-hq/tern'

import { optional } from '../core/assert.js'
import { type Check, checkGroup, checksSummary, failedRuns, type PullRequest } from '../github/pullRequest.js'
import { durationWhole, plural } from '../view/format.js'

import { checksTone } from './look.js'

const CHECK: Record<Check['status'], { tone: Tone; icon: string; word: string }> = {
  'action-required': { icon: 'pending', tone: 'warning', word: 'waiting for approval' },
  cancelled: { icon: 'cancelled', tone: 'muted', word: 'cancelled' },
  failure: { icon: 'failed', tone: 'error', word: 'failed' },
  neutral: { icon: 'minus', tone: 'muted', word: 'neutral' },
  pending: { icon: 'running', tone: 'warning', word: 'running' },
  skipped: { icon: 'minus', tone: 'muted', word: 'skipped' },
  success: { icon: 'success', tone: 'success', word: 'passed' }
}

/** How long check `c` took, or has run so far. */
function took(c: Check, now: number): string {
  return c.startedAt && c.completedAt
    ? durationWhole(Date.parse(c.completedAt) - Date.parse(c.startedAt))
    : c.startedAt && c.status === 'pending'
      ? `${durationWhole(now - Date.parse(c.startedAt))}…`
      : ''
}

/** The checks in four folds: failing and running open, passed and skipped folded. */
export function checksTab(pr: PullRequest, now: number): JSX.Element[] {
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
            <row align="center" gap="sm" key={`k${i}`} role="hermes.pr.check" {...optional('title', c.description)}>
              <icon key="i" name={CHECK[c.status].icon} tone={CHECK[c.status].tone} />
              <text grow={1} key="n" spans={[{ ...optional('href', c.url), t: c.name }]} truncate="end" wrap="none" />
              {c.workflow && !c.name.startsWith(`${c.workflow} /`) ? <text key="w" spans={[{ s: 'dim', t: c.workflow }]} truncate="end" wrap="none" /> : null}
              <text key="s" spans={[{ s: CHECK[c.status].tone === 'muted' ? 'dim' : CHECK[c.status].tone, t: CHECK[c.status].word }]} wrap="none" />
              <text key="t" spans={[{ s: 'dim mono', t: took(c, now) }]} wrap="none" />
            </row>
          ))}
        </section>
      ))
  ]
}
