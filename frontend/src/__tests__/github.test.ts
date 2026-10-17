import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { GitHub } from '../github/client.js'
import { linkedFromResult, prKey, storedLinks } from '../github/links.js'
import {
  batchQuery,
  checksState,
  checksSummary,
  checkStatus,
  dedupeChecks,
  failedRuns,
  parseActivity,
  parsePullRequest,
  type PrRef
} from '../github/pullRequest.js'
import { PullRequests } from '../github/store.js'
import type { ToolCall } from '../model.js'

const ref = (number: number, repository = 'acme/app'): PrRef => ({
  host: 'github.com',
  number,
  repository,
  url: `https://github.com/${repository}/pull/${number}`
})

const linkCall = (linked: PrRef[], status: ToolCall['status'] = 'done'): ToolCall => ({
  args: {},
  argsText: '',
  context: '',
  id: 'l',
  name: 'link_pull_request',
  result: JSON.stringify({ already_linked: false, linked }),
  startedAt: 0,
  status
})

const prJson = (over: Record<string, unknown> = {}) => ({
  mergeCommitAllowed: true,
  pullRequest: {
    additions: 10,
    author: { login: 'sid' },
    baseRef: { compare: { behindBy: 2 } },
    baseRefName: 'main',
    changedFiles: 3,
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  { __typename: 'CheckRun', completedAt: '2026-01-01T00:01:00Z', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/app/actions/runs/77/job/1', name: 'test', startedAt: '2026-01-01T00:00:00Z', status: 'COMPLETED' },
                  { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS', targetUrl: 'https://ci' }
                ]
              }
            }
          }
        }
      ]
    },
    createdAt: '2026-01-01T00:00:00Z',
    deletions: 4,
    headRefName: 'feat/x',
    headRefOid: 'abc1234',
    id: 'PR_1',
    isDraft: false,
    labels: { nodes: [{ name: 'bug' }] },
    latestReviews: { nodes: [{ author: { login: 'ana' }, state: 'APPROVED' }] },
    mergeable: 'MERGEABLE',
    number: 5,
    reviewDecision: 'APPROVED',
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'bo' } }] },
    state: 'OPEN',
    title: 'Fix it',
    updatedAt: '2026-01-02T00:00:00Z',
    url: 'https://github.com/acme/app/pull/5',
    viewerCanUpdate: true,
    ...over
  },
  rebaseMergeAllowed: false,
  squashMergeAllowed: true
})

describe('links', () => {
  it('takes the whole list from a successful link tool result', () => {
    expect(linkedFromResult(linkCall([ref(1), ref(2)]))?.map(prKey)).toEqual(['github.com/acme/app#1', 'github.com/acme/app#2'])
    expect(linkedFromResult(linkCall([ref(1)], 'error'))).toBeUndefined()
    expect(linkedFromResult({ ...linkCall([ref(1)]), name: 'terminal' })).toBeUndefined()
  })

  it('finds a compressed conversation’s links through its ancestors', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tern-prs-')), 'pull-requests.json')
    writeFileSync(file, JSON.stringify({ aliases: { root: 'root', mid: 'root' }, conversations: { root: [ref(7)] }, version: 1 }))

    // `tip` came after the last link (compression), so only its parent is an alias.
    expect(storedLinks('tip', file, () => ['tip', 'mid', 'root']).map(r => r.number)).toEqual([7])
    expect(storedLinks('other', file, () => ['other'])).toEqual([])
    expect(storedLinks('tip', join(file, 'missing'), () => ['tip'])).toEqual([])
  })
})

describe('pull request data', () => {
  it('maps check states as T3 Code does', () => {
    expect(checkStatus('IN_PROGRESS', '')).toBe('pending')
    expect(checkStatus('COMPLETED', 'TIMED_OUT')).toBe('failure')
    expect(checkStatus('COMPLETED', 'ACTION_REQUIRED')).toBe('action-required')
    expect(checkStatus('COMPLETED', 'STALE')).toBe('neutral')
  })

  it('keeps the newest run of a check and names a check two workflows share by workflow', () => {
    const checks = dedupeChecks([
      { completedAt: '2026-01-01T00:00:00Z', name: 'test', status: 'failure', workflow: 'CI' },
      { completedAt: '2026-01-02T00:00:00Z', name: 'test', status: 'success', workflow: 'CI' },
      { name: 'test', status: 'success', workflow: 'Nightly' }
    ])

    expect(checks.map(c => `${c.name}:${c.status}`)).toEqual(['CI / test:success', 'Nightly / test:success'])
  })

  it('rolls checks up: a failure fails, a wait pends', () => {
    expect(checksState([])).toBe('none')
    expect(checksState([{ name: 'a', status: 'success' }, { name: 'b', status: 'pending' }])).toBe('pending')
    expect(checksState([{ name: 'a', status: 'cancelled' }, { name: 'b', status: 'pending' }])).toBe('failing')
    expect(checksSummary([{ name: 'a', status: 'failure' }, { name: 'b', status: 'success' }, { name: 'c', status: 'success' }])).toBe(
      '1 failing, 2 passing'
    )
  })

  it('reads a PR: reviewers from requests and reviews, checks, merge methods', () => {
    const pr = parsePullRequest(ref(5), prJson())!

    expect(pr.title).toBe('Fix it')
    expect(pr.reviewers).toEqual([
      { login: 'bo', state: 'PENDING' },
      { login: 'ana', state: 'APPROVED' }
    ])
    expect(pr.checks.map(c => c.status)).toEqual(['failure', 'success'])
    expect(pr.mergeMethods).toEqual(['squash', 'merge'])
    expect(pr.behindBy).toBe(2)
    expect(failedRuns(pr.checks)).toEqual([77])
    expect(parsePullRequest(ref(5), { pullRequest: null })).toBeUndefined()
  })

  it('batches PRs as aliased repositories with their own variables', () => {
    const { query, variables } = batchQuery([ref(1), ref(2, 'acme/web')])

    expect(query).toContain('p0: repository(owner: $o0, name: $r0)')
    expect(query).toContain('compare(headRef: $h1)')
    expect(variables).toMatchObject({ h1: 'refs/pull/2/head', n1: 2, o1: 'acme', r1: 'web' })
  })

  it('orders activity oldest first and drops wordless plain reviews', () => {
    const items = parseActivity({
      repository: {
        pullRequest: {
          comments: { nodes: [{ author: { login: 'a' }, body: 'hi', createdAt: '2026-01-02T00:00:00Z' }] },
          commits: { nodes: [{ commit: { author: { user: { login: 'c' } }, committedDate: '2026-01-01T00:00:00Z', messageHeadline: 'init' } }] },
          reviewThreads: {
            nodes: [
              {
                comments: { nodes: [{ author: { login: 'r' }, body: 'nit', createdAt: '2026-01-03T00:00:00Z' }, { author: { login: 'a' }, body: 'done', createdAt: '2026-01-04T00:00:00Z' }] },
                isResolved: true,
                line: 4,
                path: 'a.ts'
              }
            ]
          },
          reviews: { nodes: [{ author: { login: 'r' }, body: '', state: 'COMMENTED', submittedAt: '2026-01-03T00:00:00Z' }] }
        }
      }
    })

    expect(items.map(i => `${i.kind}:${i.author}`)).toEqual(['commit:c', 'comment:a', 'thread:r'])
    expect(items[2]?.replies?.map(r => r.body)).toEqual(['done'])
  })
})

describe('PullRequests', () => {
  it('follows link results and reads each PR in one batch per host', async () => {
    const graphql = vi.fn(async () => ({ p0: prJson() }))
    const gh = { graphql, rest: vi.fn() } as unknown as GitHub
    const changed = vi.fn()
    const store = new PullRequests({ changed, sid: () => 's1' }, gh, () => [])

    store.adopt()
    store.onCall(linkCall([ref(5)]))
    await vi.waitFor(() => expect(store.entries()[0]?.pr?.title).toBe('Fix it'))
    expect(graphql).toHaveBeenCalledWith('github.com', expect.stringContaining('pullRequest(number: $n0)'), expect.objectContaining({ n0: 5 }))

    await store.act('merge', 'github.com/acme/app#5')
    expect(graphql).toHaveBeenCalledWith('github.com', expect.stringContaining('mergePullRequest'), { id: 'PR_1', m: 'SQUASH', oid: 'abc1234' })
    store.dispose()
  })

  it('says once why nothing could be read', async () => {
    const gh = { graphql: vi.fn(async () => Promise.reject(new Error('Not logged in to github.com.'))), rest: vi.fn() } as unknown as GitHub
    const store = new PullRequests({ changed: vi.fn(), sid: () => 's1' }, gh, () => [ref(1), ref(2)])

    store.adopt()
    await vi.waitFor(() => expect(store.error).toBe('Not logged in to github.com.'))
    store.dispose()
  })
})
