// The Conversation tab of a pull request: its description, then every comment, review, review
// thread and commit in order, each drawn as GitHub draws it. Runs of commits fold into one line.

import type { JSX, SpanData, Tone } from '@stencil-hq/tern'

import type { ActivityItem, PullRequest } from '../github/pullRequest.js'
import type { Entry } from '../github/store.js'
import { relative } from '../processes/cron.js'
import { plural } from '../view/format.js'

import { type BodyLinks, bodyNodes } from './body.js'

const COMMENTED: [string, Tone] = ['reviewed', 'muted']

/** A review's verdict, as GitHub words it, and its tone. */
const REVIEW: Record<string, [string, Tone]> = {
  APPROVED: ['approved these changes', 'success'],
  CHANGES_REQUESTED: ['requested changes', 'error'],
  COMMENTED,
  DISMISSED: ['reviewed (dismissed)', 'muted'],
  PENDING: ['started a review', 'muted']
}

/** The description, then every event in order, as GitHub's Conversation tab lists them. */
export function conversation(e: Entry, pr: PullRequest, now: number): JSX.Element[] {
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
    const last = commits.at(-1)

    if (last) {
      out.push(commitRun(commits, last, `c${out.length}`, now))
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
      const [verb, tone] = REVIEW[a.state ?? 'COMMENTED'] ?? COMMENTED

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

/** A comment card: who and when in its head, the body as GitHub draws it, its permalink. */
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

/** A review thread on a line: folded once resolved or outdated, its replies under it. */
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

/** A run of commits as one line, `last` the newest, then one row per commit. */
function commitRun(commits: ActivityItem[], last: ActivityItem, key: string, now: number): JSX.Element {
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
            { s: 'dim', t: ` · ${relative(last.at, now)}` }
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
