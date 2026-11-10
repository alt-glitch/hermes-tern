import { describe, expect, it, vi } from 'vitest'

import { liveSessionId, prKey, toolCallId } from '../core/ids.js'
import { type BranchTarget, parseRemote, parseStacks } from '../github/branch.js'
import { linkedFromResult, linkedPullRequests } from '../github/links.js'
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
import { shown } from '../github/remote.js'
import { PullRequests } from '../github/store.js'
import type { ToolCall } from '../model.js'

import { FakeGateway, must } from './fakes.js'

const ref = (number: number, repository = 'acme/app'): PrRef => ({
  host: 'github.com',
  number,
  repository,
  url: `https://github.com/${repository}/pull/${number}`
})

const linkCall = (linked: PrRef[], kind: 'done' | 'error' = 'done'): ToolCall => ({
  args: {},
  argsText: '',
  context: '',
  id: toolCallId('l'),
  name: 'link_pull_request',
  result: JSON.stringify({ already_linked: false, linked }),
  outcome: { duration: 0, kind },
  startedAt: 0,
  via: { kind: 'direct' }
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
    const pr = must(parsePullRequest(ref(5), prJson()))

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
    const gh = { graphql, rest: vi.fn() }
    const changed = vi.fn()
    const store = new PullRequests({ changed, cwd: () => null, sid: () => liveSessionId('s1'), links: async () => [] }, gh)

    store.adopt()
    store.onCall(linkCall([ref(5)]))
    await vi.waitFor(() => expect(store.entries()[0]?.pr?.title).toBe('Fix it'))
    expect(graphql).toHaveBeenCalledWith('github.com', expect.stringContaining('pullRequest(number: $n0)'), expect.objectContaining({ n0: 5 }))

    await store.act('merge', prKey(ref(5)))
    expect(graphql).toHaveBeenCalledWith('github.com', expect.stringContaining('mergePullRequest'), { id: 'PR_1', m: 'SQUASH', oid: 'abc1234' })
    store.dispose()
  })

  it("reads the conversation's links on adopt, and again when told they changed", async () => {
    const gh = { graphql: vi.fn(async () => ({})), rest: vi.fn() }
    let stored = [ref(1)]
    const links = vi.fn(async () => stored)
    const store = new PullRequests({ changed: vi.fn(), cwd: () => null, links, sid: () => liveSessionId('s1') }, gh)

    store.adopt()
    await vi.waitFor(() => expect(store.entries().map(e => e.ref.number)).toEqual([1]))

    stored = [ref(1), ref(2)]
    store.relink()

    await vi.waitFor(() => expect(store.entries().map(e => e.ref.number)).toEqual([1, 2]))
    expect(links).toHaveBeenLastCalledWith('s1')
    store.dispose()
  })

  it('asks the plugin for the links of the session it names, and reads a malformed answer as none', async () => {
    const gw = new FakeGateway({ replies: { 'plugin.hermes-tern.pull_requests.linked': () => ({ linked: [ref(3), { host: 'github.com' }] }) } })

    expect((await linkedPullRequests(gw.client, 's1')).map(r => r.number)).toEqual([3])
    expect(gw.sent('plugin.hermes-tern.pull_requests.linked')).toEqual([{ session_id: 's1' }])

    gw.handlers.set('plugin.hermes-tern.pull_requests.linked', () => ({}))
    expect(await linkedPullRequests(gw.client, 's1')).toEqual([])
  })
  it('says once why nothing could be read', async () => {
    const gh = { graphql: vi.fn(async () => Promise.reject(new Error('Not logged in to github.com.'))), rest: vi.fn() }
    const store = new PullRequests({ changed: vi.fn(), cwd: () => null, sid: () => liveSessionId('s1'), links: async () => [ref(1), ref(2)] }, gh)

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
    const store = new PullRequests({ changed: vi.fn(), cwd: () => null, sid: () => liveSessionId('s1'), links: async () => [ref(5)] }, { graphql, rest })
    const reads = () => graphql.mock.calls.filter(c => c[1] === ACTIVITY_QUERY).length

    return { at, reads, rest, store }
  }
  const KEY = prKey(ref(5))
  const IDLE = { kind: 'idle' } as const

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

    expect(shown(store.get(KEY)?.files ?? IDLE).value?.map(f => f.path)).toEqual(['B.ts'])
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
    expect(shown(store.get(KEY)?.activity ?? IDLE).error).toBe('rate limited')
    // The sheet asks on every frame: no new read until the wait is over.
    await store.activity(KEY)
    expect(reads()).toBe(1)

    at.fail = false
    now.mockReturnValue(1_000_000 + 30_000)
    await Promise.all([store.activity(KEY), store.activity(KEY)])
    expect(reads()).toBe(2)
    expect(shown(store.get(KEY)?.activity ?? IDLE).error).toBeUndefined()
    expect(shown(store.get(KEY)?.activity ?? IDLE).value?.length).toBe(1)
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
    const store = new PullRequests({ changed: vi.fn(), cwd: () => null, sid: () => liveSessionId('s1'), links: async () => [ref(5)] }, { graphql, rest: vi.fn() })
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
    expect(parseRemote('git@gitlab.com:acme/app.git')).toBeUndefined()
  })

  it('reads a remote only on github.com or a listed enterprise host: the checkout names it, not the user', () => {
    vi.stubEnv('HERMES_TERN_GITHUB_ENTERPRISE_HOSTS', 'ghe.corp.example,git.corp.example:8443')

    try {
      expect(parseRemote('git@github.evil.com:acme/app.git')).toBeUndefined()
      expect(parseRemote('https://github.mycompany.com/acme/app')).toBeUndefined()
      expect(parseRemote('https://GitHub.com./acme/app')).toEqual({ host: 'github.com', repository: 'acme/app' })
      // An ssh remote's port is not the web server's; an https one's is.
      expect(parseRemote('ssh://git@ghe.corp.example:22/acme/app.git')).toEqual({ host: 'ghe.corp.example', repository: 'acme/app' })
      expect(parseRemote('https://git.corp.example:8443/acme/app.git')).toEqual({ host: 'git.corp.example:8443', repository: 'acme/app' })
      expect(parseRemote('https://git.corp.example/acme/app.git')).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('shows a stored link to a host the user did not list, and never reads it', async () => {
    // Linked before the tool checked hosts: pull-requests.json may still name one.
    const evil: PrRef = { host: 'github.evil.com', number: 1, repository: 'acme/app', url: 'https://github.evil.com/acme/app/pull/1' }
    const graphql = vi.fn(async (_host: string) => ({ p0: prJson() }))
    const rest = vi.fn(async (_host: string) => [])
    const store = new PullRequests({ changed: vi.fn(), cwd: () => null, sid: () => liveSessionId('s1'), links: async () => [evil, ref(5)] }, { graphql, rest })

    store.adopt()
    await vi.waitFor(() => expect(store.entries()[1]?.pr?.title).toBe('Fix it'))
    expect(new Set([...graphql.mock.calls, ...rest.mock.calls].map(c => c[0]))).toEqual(new Set(['github.com']))
    expect(store.entries()[0]?.error).toContain('plugins.entries.hermes-tern.settings.enterprise_hosts')
    expect(store.error).toBeUndefined()
    store.dispose()
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
      { changed: vi.fn(), cwd: () => '/wt', links: async () => [ref(5)], sid: () => liveSessionId('s1') },
      { graphql, rest },
      async () => ({ head: 'y', host: 'github.com', repository: 'acme/app' })
    )

    store.adopt()
    await vi.waitFor(() => expect(store.entries().map(e => `${e.ref.number}:${e.source}`)).toEqual(['5:linked', '9:branch', '8:stack']))
    await vi.waitFor(() => expect(store.entries().every(e => e.pr)).toBe(true))
    expect(store.entries().find(e => e.ref.number === 8)?.stack?.layers.map(l => l.number)).toEqual([8, 9])
    store.dispose()
  })

  it("drops a read for the last session that answers after an adopt, so its branch PR never shows on the new one", async () => {
    const graphql = vi.fn(async (_host: string, query: string, variables: Record<string, unknown>) => {
      if (query.includes('pullRequests(headRefName')) {
        const number = variables['h'] === 'old' ? 7 : 9

        return { repository: { pullRequests: { nodes: [{ headRepositoryOwner: { login: 'acme' }, number, state: 'OPEN', url: `https://github.com/acme/app/pull/${number}` }] } } }
      }

      return Object.fromEntries(
        Object.keys(variables)
          .filter(k => k.startsWith('n'))
          .map(k => [`p${k.slice(1)}`, prJson({ number: variables[k] })])
      )
    })
    const lookups: ((target: BranchTarget) => void)[] = []
    const branchOf = () => new Promise<BranchTarget | undefined>(resolve => lookups.push(resolve))
    let shown = { cwd: '/a', sid: liveSessionId('s1') }
    const store = new PullRequests({ changed: vi.fn(), cwd: () => shown.cwd, sid: () => shown.sid, links: async () => [] }, { graphql, rest: vi.fn() }, branchOf)

    store.adopt()
    await vi.waitFor(() => expect(lookups).toHaveLength(1))

    shown = { cwd: '/b', sid: liveSessionId('s2') }
    store.adopt()
    must(lookups[0])({ head: 'old', host: 'github.com', repository: 'acme/app' })

    // The new session's own lookup runs next; the old answer left nothing behind.
    await vi.waitFor(() => expect(lookups).toHaveLength(2))
    expect(store.entries()).toEqual([])

    must(lookups[1])({ head: 'new', host: 'github.com', repository: 'acme/app' })
    await vi.waitFor(() => expect(store.entries().map(e => `${e.ref.number}:${e.source}`)).toEqual(['9:branch']))
    store.dispose()
  })

  it('lists without writing: entries() projects the store, and the stored entries carry no list fields', async () => {
    const graphql = vi.fn(async () => ({ p0: prJson() }))
    // The round waits on the branch lookup until the test lets it go, so the listing is seen before any read.
    let release: (target: BranchTarget | undefined) => void = () => {}
    const branchOf = () => new Promise<BranchTarget | undefined>(resolve => (release = resolve))
    const store = new PullRequests(
      { changed: vi.fn(), cwd: () => '/repo', links: async () => [ref(5)], sid: () => liveSessionId('s1') },
      { graphql, rest: vi.fn() },
      branchOf
    )
    const key = prKey(ref(5))

    store.adopt()
    await vi.waitFor(() => expect(store.entries().map(e => `${e.ref.number}:${e.source}`)).toEqual(['5:linked']))
    // Listing made no entry (the read does): get() answers a blank, not a stored one.
    expect(store.get(key)).not.toBe(store.get(key))
    release(undefined)

    await vi.waitFor(() => expect(store.entries()[0]?.pr?.title).toBe('Fix it'))
    expect(store.get(key)).toBe(store.get(key))
    expect(store.get(key)).not.toHaveProperty('source')
    expect(store.entries()[0]).not.toBe(store.entries()[0])
    store.dispose()
  })
})
