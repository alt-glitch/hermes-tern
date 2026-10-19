import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it, vi } from 'vitest'

import { parseRemote, parseStacks } from '../github/branch.js'
import type { GitHub } from '../github/client.js'
import { ancestry, linkedFromResult, prKey, storedLinks } from '../github/links.js'
import {
  ACTIVITY_QUERY,
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

  it('climbs only compression continuations, not a /branch, delegate, reset or tool child', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'tern-lineage-')), 'state.db')
    const conn = new DatabaseSync(db)
    conn.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, parent_session_id TEXT, model_config TEXT, end_reason TEXT)')
    const add = conn.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)')
    add.run('root', 'tui', null, '{}', 'compression')
    // A continuation copies model_config, so it may carry an older marker that names another row.
    add.run('mid', 'tui', 'root', '{"_branched_from":"elder"}', 'compression')
    add.run('tip', 'tui', 'mid', 'not json', null)
    add.run('branch', 'tui', 'tip', '{"_branched_from":"tip"}', null)
    add.run('fork', 'tui', 'mid', '{"_branched_from":"mid"}', null)
    add.run('reset', 'tui', 'mid', '{"_reset_from":"mid"}', null)
    add.run('agent', 'tui', 'mid', '{"_delegate_from":"mid"}', null)
    add.run('tool', 'tool', 'mid', '{}', null)
    add.run('open', 'tui', 'tip', '{}', null)
    conn.close()

    expect(ancestry('tip', db)).toEqual(['tip', 'mid', 'root'])
    expect(['branch', 'fork', 'reset', 'agent', 'tool'].map(id => ancestry(id, db))).toEqual([['branch'], ['fork'], ['reset'], ['agent'], ['tool']])
    // `tip` did not end in compression, so a plain child of it is not its continuation.
    expect(ancestry('open', db)).toEqual(['open'])
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
    const store = new PullRequests({ changed, cwd: () => null, sid: () => 's1' }, gh, () => [])

    store.adopt()
    store.onCall(linkCall([ref(5)]))
    await vi.waitFor(() => expect(store.entries()[0]?.pr?.title).toBe('Fix it'))
    expect(graphql).toHaveBeenCalledWith('github.com', expect.stringContaining('pullRequest(number: $n0)'), expect.objectContaining({ n0: 5 }))

    await store.act('merge', 'github.com/acme/app#5')
    expect(graphql).toHaveBeenCalledWith('github.com', expect.stringContaining('mergePullRequest'), { id: 'PR_1', m: 'SQUASH', oid: 'abc1234' })
    store.dispose()
  })

  it("re-reads the stored links for a subagent's link, which this transcript never sees", async () => {
    const gh = { graphql: vi.fn(async () => ({})), rest: vi.fn() } as unknown as GitHub
    const changed = vi.fn()
    let stored = [ref(1)]
    const links = vi.fn(() => stored)
    const store = new PullRequests({ changed, cwd: () => null, sid: () => 's1' }, gh, links)

    store.adopt()
    store.relink()
    expect(changed).toHaveBeenCalledTimes(1)

    stored = [ref(1), ref(2)]
    store.relink()

    expect(links).toHaveBeenLastCalledWith('s1')
    expect(store.entries().map(e => e.ref.number)).toEqual([1, 2])
    expect(changed).toHaveBeenCalledTimes(2)
    store.dispose()
  })

  it('says once why nothing could be read', async () => {
    const gh = { graphql: vi.fn(async () => Promise.reject(new Error('Not logged in to github.com.'))), rest: vi.fn() } as unknown as GitHub
    const store = new PullRequests({ changed: vi.fn(), cwd: () => null, sid: () => 's1' }, gh, () => [ref(1), ref(2)])

    store.adopt()
    await vi.waitFor(() => expect(store.error).toBe('Not logged in to github.com.'))
    store.dispose()
  })

  /** A store on PR #5 whose `updatedAt` the test moves, with its activity and files reads counted. */
  const detailStore = () => {
    const at = { fail: false, now: 'A' }
    const graphql = vi.fn(async (_host: string, query: string) => {
      if (query !== ACTIVITY_QUERY) {
        return { p0: prJson({ updatedAt: at.now }) }
      }

      if (at.fail) {
        throw new Error('rate limited')
      }

      return { repository: { pullRequest: { comments: { nodes: [{ author: { login: 'a' }, body: at.now, createdAt: '2026-01-02T00:00:00Z' }] } } } }
    })
    const rest = vi.fn(async () => [{ filename: `${at.now}.ts`, status: 'modified' }])
    const store = new PullRequests({ changed: vi.fn(), cwd: () => null, sid: () => 's1' }, { graphql, rest } as unknown as GitHub, () => [ref(5)])
    const reads = () => graphql.mock.calls.filter(c => c[1] === ACTIVITY_QUERY).length

    return { at, reads, rest, store }
  }
  const KEY = 'github.com/acme/app#5'

  it('keeps the files and the activity fresh apart: one tab read does not vouch for the other', async () => {
    const { at, rest, store } = detailStore()
    store.adopt()
    await vi.waitFor(() => expect(store.get(KEY)?.pr?.updatedAt).toBe('A'))

    await store.files(KEY)
    at.now = 'B'
    store.poke()
    await vi.waitFor(() => expect(store.get(KEY)?.pr?.updatedAt).toBe('B'))
    await store.activity(KEY)
    await store.files(KEY)

    expect(store.get(KEY)?.files?.map(f => f.path)).toEqual(['B.ts'])
    // Read once per update, even with no activity read yet.
    await store.files(KEY)
    expect(rest).toHaveBeenCalledTimes(2)
    store.dispose()
  })

  it('records a failed tab read, reads once at a time and tries again after a while', async () => {
    const { at, reads, store } = detailStore()
    store.adopt()
    await vi.waitFor(() => expect(store.get(KEY)?.pr).toBeDefined())
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)

    at.fail = true
    await expect(store.activity(KEY)).rejects.toThrow('rate limited')
    expect(store.get(KEY)?.activityError).toBe('rate limited')
    // The sheet asks on every frame: no new read until the wait is over.
    await store.activity(KEY)
    expect(reads()).toBe(1)

    at.fail = false
    now.mockReturnValue(1_000_000 + 30_000)
    await Promise.all([store.activity(KEY), store.activity(KEY)])
    expect(reads()).toBe(2)
    expect(store.get(KEY)?.activityError).toBeUndefined()
    expect(store.get(KEY)?.activity?.length).toBe(1)
    now.mockRestore()
    store.dispose()
  })

  it('turns stack grouping off only for a schema with no stack field, not for a failed request', async () => {
    let failure = 'GitHub answered 502'
    const graphql = vi.fn(async (_host: string, query: string) => {
      if (query.includes('stack { number }')) {
        throw new Error(failure)
      }

      return { p0: prJson() }
    })
    const store = new PullRequests({ changed: vi.fn(), cwd: () => null, sid: () => 's1' }, { graphql, rest: vi.fn() } as unknown as GitHub, () => [ref(5)])
    const asked = () => graphql.mock.calls.filter(c => c[1].includes('stack { number }')).length

    const round = async () => {
      store.poke()
      await vi.waitFor(() => expect(store.loading).toBe(false))
    }

    store.adopt()
    await vi.waitFor(() => expect(store.loading).toBe(false))
    await round()
    expect(asked()).toBe(2)

    failure = "Field 'stack' doesn't exist on type 'PullRequest'"
    await round()
    await round()
    expect(asked()).toBe(3)
    store.dispose()
  })
})

describe('branch and stacks', () => {
  it('reads GitHub remotes in every URL form, and nothing else', () => {
    expect(parseRemote('git@github.com:Acme/App.git')).toEqual({ host: 'github.com', repository: 'acme/app' })
    expect(parseRemote('https://github.com/acme/app')).toEqual({ host: 'github.com', repository: 'acme/app' })
    expect(parseRemote('ssh://git@github.example.com:22/acme/app.git')).toEqual({ host: 'github.example.com', repository: 'acme/app' })
    expect(parseRemote('git@gitlab.com:acme/app.git')).toBeUndefined()
  })

  it('decodes /stacks bottom first, merged layers as merged', () => {
    const [s] = parseStacks('github.com', 'acme/app', [
      { base: { ref: 'main' }, number: 3, pull_requests: [{ head: { ref: 'a' }, merged_at: '2026-01-01', number: 1 }, { head: { ref: 'b' }, number: 2, state: 'open' }] }
    ])

    expect(s?.layers).toEqual([
      { head: 'a', number: 1, state: 'merged' },
      { head: 'b', number: 2, state: 'open' }
    ])
    expect(s?.key).toBe('github.com/acme/app#stack:3')
  })

  it('adds the branch PR and the other layers of a stack a listed PR sits in', async () => {
    const graphql = vi.fn(async (_host: string, query: string, variables: Record<string, unknown>) => {
      if (query.includes('pullRequests(headRefName')) {
        return { repository: { pullRequests: { nodes: [{ headRepositoryOwner: { login: 'acme' }, number: 9, state: 'OPEN', url: 'https://github.com/acme/app/pull/9' }] } } }
      }

      if (query.includes('stack { number }')) {
        return Object.fromEntries(Object.keys(variables).filter(k => k.startsWith('n')).map(k => [`p${k.slice(1)}`, { pullRequest: { stack: variables[k] === 9 ? { number: 4 } : null } }]))
      }

      return Object.fromEntries(
        Object.keys(variables)
          .filter(k => k.startsWith('n'))
          .map(k => [`p${k.slice(1)}`, prJson({ number: variables[k], title: `PR ${variables[k]}` })])
      )
    })
    const rest = vi.fn(async () => [{ base: 'main', number: 4, pull_requests: [{ head: { ref: 'x' }, number: 8 }, { head: { ref: 'y' }, number: 9 }] }])
    const store = new PullRequests(
      { changed: vi.fn(), cwd: () => '/wt', sid: () => 's1' },
      { graphql, rest } as unknown as GitHub,
      () => [ref(5)],
      async () => ({ head: 'y', host: 'github.com', repository: 'acme/app' })
    )

    store.adopt()
    await vi.waitFor(() => expect(store.entries().map(e => `${e.ref.number}:${e.source}`)).toEqual(['5:linked', '9:branch', '8:stack']))
    await vi.waitFor(() => expect(store.entries().every(e => e.pr)).toBe(true))
    expect(store.entries().find(e => e.ref.number === 8)?.stack?.layers.map(l => l.number)).toEqual([8, 9])
    store.dispose()
  })
})
