// A pull request as the sheet shows it, read from GitHub's GraphQL API. The fields and the check
// mapping follow T3 Code's PullRequestCore query and gitHubPullRequestJson.ts (MIT, T3 Tools Inc.),
// cut down to what a terminal sheet draws.

import * as z from 'zod/mini'

import { rowsOf } from '../wire/schemas.js'

export interface PrRef {
  host: string
  /** `owner/repo`, lower case. */
  repository: string
  number: number
  url: string
}

export type PrState = 'closed' | 'merged' | 'open'
export type CheckStatus = 'action-required' | 'cancelled' | 'failure' | 'neutral' | 'pending' | 'skipped' | 'success'
export type ChecksState = 'failing' | 'none' | 'passing' | 'pending'
export type MergeMethod = 'merge' | 'rebase' | 'squash'

export interface Check {
  name: string
  workflow?: string | undefined
  status: CheckStatus
  url?: string | undefined
  description?: string | undefined
  startedAt?: string | undefined
  completedAt?: string | undefined
}

export interface Reviewer {
  login: string
  /** The latest review's state, or `PENDING` for a request not answered yet. */
  state: string
}

export interface PullRequest extends PrRef {
  /** GraphQL node id, for mutations. */
  id: string
  title: string
  body: string
  state: PrState
  draft: boolean
  author: string
  head: string
  base: string
  headOid: string
  additions: number
  deletions: number
  changedFiles: number
  mergeable: 'conflicting' | 'mergeable' | 'unknown'
  mergeState: string
  reviewDecision: string | null
  labels: string[]
  reviewers: Reviewer[]
  checks: Check[]
  autoMerge: string | null
  createdAt: string
  updatedAt: string
  mergedAt: string | null
  closedAt: string | null
  /** The merge methods the repository allows, preferred first. */
  mergeMethods: MergeMethod[]
  /** The viewer may change the PR (merge, close, ready…). */
  canUpdate: boolean
  /** Commits the base has that the head lacks. */
  behindBy: number | null
}

const CHECK_FIELDS = `
  __typename
  ... on CheckRun { name status conclusion startedAt completedAt detailsUrl
    checkSuite { workflowRun { workflow { name } } } }
  ... on StatusContext { context state targetUrl description createdAt }`

/** The fields of one PR (`PullRequestCore`, less what the sheet never draws). */
export const PR_FIELDS = `
  id number title url body state isDraft mergeable mergeStateStatus reviewDecision
  additions deletions changedFiles createdAt updatedAt mergedAt closedAt
  headRefName baseRefName headRefOid viewerCanUpdate
  author { login }
  autoMergeRequest { mergeMethod }
  baseRef { compare(headRef: $head) { behindBy } }
  labels(first: 20) { nodes { name } }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Team { name } } } }
  latestReviews(first: 20) { nodes { author { login } state } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { ${CHECK_FIELDS} } } } } } }`

const REPO_FIELDS = 'mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed'

/**
 * One query for many PRs of one host: an aliased `repository { pullRequest }` per ref. `baseRef.compare`
 * needs the head as a ref name, so each alias passes `refs/pull/N/head` through its own variable.
 */
export function batchQuery(refs: readonly PrRef[]): { query: string; variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = {}
  const decls: string[] = []
  const parts = refs.map((ref, i) => {
    const [owner, name] = ref.repository.split('/')
    variables[`o${i}`] = owner
    variables[`r${i}`] = name
    variables[`n${i}`] = ref.number
    variables[`h${i}`] = `refs/pull/${ref.number}/head`
    decls.push(`$o${i}: String!, $r${i}: String!, $n${i}: Int!, $h${i}: String!`)

    return `p${i}: repository(owner: $o${i}, name: $r${i}) { ${REPO_FIELDS} pullRequest(number: $n${i}) { ${PR_FIELDS.replace('$head', `$h${i}`)} } }`
  })

  return { query: `query(${decls.join(', ')}) { ${parts.join('\n')} }`, variables }
}

/** A batch query's answers by alias (`p0`, `p1`…); an answer that is not an object has none. */
export const batchAnswers = z.catch(z.record(z.string(), z.unknown()), {})

// ── Parsing ───────────────────────────────────────────────────────────────────────────────────
// GitHub's answers read through node schemas as leniently as T3 Code's decoders: text GitHub did
// not send reads as '', a count as 0, a flag as unset, an object as one with every field at that
// default, and a list of nodes keeps only the nodes that are objects.

/** Text; '' when GitHub sent none. */
const text = z.catch(z.string(), '')
/** A count; 0 when GitHub sent none. */
const count = z.catch(z.number(), 0)
/** A flag, set only by `true`. */
const flag = z.catch(z.boolean(), false)

/** `schema`'s object, or the object `{}` reads as (each field at its default) when GitHub sent none. */
const orEmpty = <T>(schema: z.ZodMiniType<T>) => z.catch(schema, () => schema.parse({}))

/** A connection's `nodes`, each read by `node`; one that is not an object is dropped, and no list reads as none. */
const nodesOf = <T>(node: z.ZodMiniType<T>) =>
  z.pipe(z.catch(z.object({ nodes: z.catch(z.array(z.unknown()), []) }), { nodes: [] }), z.transform(c => rowsOf(node, c.nodes)))

/** A user as GitHub names one; '' for a deleted account. */
const actor = orEmpty(z.object({ login: text }))

/** One status context or check run of a commit's rollup (CHECK_FIELDS). */
const checkNode = z.object({
  __typename: text,
  context: text,
  state: text,
  targetUrl: text,
  description: text,
  createdAt: text,
  name: text,
  status: text,
  conclusion: text,
  startedAt: text,
  completedAt: text,
  detailsUrl: text,
  checkSuite: orEmpty(z.object({ workflowRun: orEmpty(z.object({ workflow: orEmpty(z.object({ name: text })) })) }))
})

type CheckNode = z.infer<typeof checkNode>

/** One PR as PR_FIELDS asks for it. */
const prNode = z.object({
  id: text,
  title: text,
  url: text,
  body: text,
  state: text,
  isDraft: flag,
  mergeable: text,
  mergeStateStatus: text,
  reviewDecision: text,
  additions: count,
  deletions: count,
  changedFiles: count,
  createdAt: text,
  updatedAt: text,
  mergedAt: text,
  closedAt: text,
  headRefName: text,
  baseRefName: text,
  headRefOid: text,
  viewerCanUpdate: flag,
  author: actor,
  autoMergeRequest: orEmpty(z.object({ mergeMethod: text })),
  baseRef: orEmpty(z.object({ compare: orEmpty(z.object({ behindBy: z.catch(z.nullable(z.number()), null) })) })),
  labels: nodesOf(z.object({ name: text })),
  reviewRequests: nodesOf(z.object({ requestedReviewer: orEmpty(z.object({ login: text, name: text })) })),
  latestReviews: nodesOf(z.object({ author: actor, state: text })),
  commits: nodesOf(z.object({ commit: orEmpty(z.object({ statusCheckRollup: orEmpty(z.object({ contexts: nodesOf(checkNode) })) })) }))
})

/** One aliased `repository` answer of batchQuery: the merge methods it allows, and its PR. */
const repoNode = z.object({
  squashMergeAllowed: z.optional(z.unknown()),
  mergeCommitAllowed: z.optional(z.unknown()),
  rebaseMergeAllowed: z.optional(z.unknown()),
  pullRequest: prNode
})

/** T3 Code's check status mapping (gitHubPullRequestJson.ts). */
export function checkStatus(status: string, conclusion: string): CheckStatus {
  if (status && status !== 'COMPLETED') {
    return 'pending'
  }

  switch (conclusion) {
    case 'SUCCESS':
      return 'success'

    case 'ACTION_REQUIRED':
      return 'action-required'

    case 'FAILURE':

    case 'ERROR':

    case 'TIMED_OUT':

    case 'STARTUP_FAILURE':
      return 'failure'

    case 'CANCELLED':
      return 'cancelled'

    case 'SKIPPED':
      return 'skipped'

    case 'PENDING':

    case 'EXPECTED':
      return 'pending'

    default:
      return 'neutral'
  }
}

export function parseCheck(n: CheckNode): Check {
  if (n.__typename === 'StatusContext') {
    return {
      description: n.description || undefined,
      name: n.context,
      startedAt: n.createdAt || undefined,
      status: checkStatus('COMPLETED', n.state),
      url: n.targetUrl || undefined
    }
  }

  return {
    completedAt: n.completedAt || undefined,
    name: n.name,
    startedAt: n.startedAt || undefined,
    status: checkStatus(n.status, n.conclusion),
    url: n.detailsUrl || undefined,
    workflow: n.checkSuite.workflowRun.workflow.name || undefined
  }
}

/**
 * Re-runs repeat a check: keep the newest per (workflow, name), and qualify a name two workflows
 * share as `Workflow / name` (T3 Code's pullRequestChecks.ts).
 */
export function dedupeChecks(checks: readonly Check[]): Check[] {
  const newest = new Map<string, Check>()
  const time = (c: Check) => Date.parse(c.completedAt ?? c.startedAt ?? '') || 0

  for (const c of checks) {
    const key = `${c.workflow ?? ''}\u0000${c.name}`
    const prev = newest.get(key)

    if (!prev || time(c) >= time(prev)) {
      newest.set(key, c)
    }
  }

  const list = [...newest.values()]
  const workflows = new Map<string, Set<string>>()

  for (const c of list) {
    workflows.set(c.name, (workflows.get(c.name) ?? new Set()).add(c.workflow ?? ''))
  }

  return list.map(c => ((workflows.get(c.name)?.size ?? 0) > 1 && c.workflow ? { ...c, name: `${c.workflow} / ${c.name}` } : c))
}

/** Any failure or cancel fails; else anything waiting is pending; else passing. */
export function checksState(checks: readonly Check[]): ChecksState {
  if (!checks.length) {
    return 'none'
  }

  if (checks.some(c => c.status === 'failure' || c.status === 'cancelled')) {
    return 'failing'
  }

  return checks.some(c => c.status === 'pending' || c.status === 'action-required') ? 'pending' : 'passing'
}

export type CheckGroup = 'attention' | 'completed' | 'running'

export function checkGroup(c: Check): CheckGroup {
  return c.status === 'failure' || c.status === 'cancelled' || c.status === 'action-required'
    ? 'attention'
    : c.status === 'pending'
      ? 'running'
      : 'completed'
}

/** `2 failing, 1 pending, 9 passing`. */
export function checksSummary(checks: readonly Check[]): string {
  if (!checks.length) {
    return 'No checks'
  }

  const count = (s: CheckStatus[]) => checks.filter(c => s.includes(c.status)).length
  const parts: [number, string][] = [
    [count(['failure']), 'failing'],
    [count(['cancelled']), 'cancelled'],
    [count(['action-required']), 'waiting for approval'],
    [count(['pending']), 'pending'],
    [count(['success']), 'passing'],
    [count(['skipped', 'neutral']), 'skipped']
  ]

  return parts
    .filter(([n]) => n)
    .map(([n, label]) => `${n} ${label}`)
    .join(', ')
}

const STATE: Record<string, PrState> = { CLOSED: 'closed', MERGED: 'merged', OPEN: 'open' }
const MERGEABLE: Record<string, PullRequest['mergeable']> = { CONFLICTING: 'conflicting', MERGEABLE: 'mergeable' }

/** One aliased `repository` answer; undefined when GitHub had no such PR (or no access). */
export function parsePullRequest(ref: PrRef, repo: unknown): PullRequest | undefined {
  const read = repoNode.safeParse(repo)

  if (!read.success) {
    return undefined
  }

  const r = read.data
  const p = r.pullRequest
  const reviews = new Map<string, string>()

  for (const n of p.reviewRequests) {
    const login = n.requestedReviewer.login || n.requestedReviewer.name

    if (login) {
      reviews.set(login, 'PENDING')
    }
  }

  // Someone who reviewed drops off reviewRequests: their latest review stands for them.
  for (const n of p.latestReviews) {
    const login = n.author.login

    if (login && !reviews.has(login)) {
      reviews.set(login, n.state)
    }
  }

  const rollup = p.commits[0]?.commit.statusCheckRollup.contexts ?? []
  const methods: MergeMethod[] = [
    ...(r.squashMergeAllowed ? (['squash'] as const) : []),
    ...(r.mergeCommitAllowed ? (['merge'] as const) : []),
    ...(r.rebaseMergeAllowed ? (['rebase'] as const) : [])
  ]

  return {
    ...ref,
    additions: p.additions,
    author: p.author.login || 'ghost',
    autoMerge: p.autoMergeRequest.mergeMethod || null,
    base: p.baseRefName,
    behindBy: p.baseRef.compare.behindBy,
    body: p.body,
    canUpdate: p.viewerCanUpdate,
    changedFiles: p.changedFiles,
    checks: dedupeChecks(rollup.map(parseCheck)),
    closedAt: p.closedAt || null,
    createdAt: p.createdAt,
    deletions: p.deletions,
    draft: p.isDraft,
    head: p.headRefName,
    headOid: p.headRefOid,
    id: p.id,
    labels: p.labels.map(n => n.name),
    mergeMethods: methods,
    mergeState: p.mergeStateStatus,
    mergeable: MERGEABLE[p.mergeable] ?? 'unknown',
    mergedAt: p.mergedAt || null,
    reviewDecision: p.reviewDecision || null,
    reviewers: [...reviews].map(([login, state]) => ({ login, state })),
    state: STATE[p.state] ?? 'open',
    title: p.title,
    updatedAt: p.updatedAt,
    url: p.url || ref.url
  }
}

// ── Activity: comments, reviews, review threads, commits ──────────────────────────────────────

export interface ActivityItem {
  kind: 'comment' | 'commit' | 'review' | 'thread'
  author: string
  at: string
  body: string
  url?: string
  /** A review's verdict (APPROVED, CHANGES_REQUESTED, COMMENTED). */
  state?: string
  /** A review thread's file and line. */
  path?: string
  line?: number | null
  resolved?: boolean
  outdated?: boolean
  replies?: { author: string; body: string; at: string }[]
}

export const ACTIVITY_QUERY = `query($o: String!, $r: String!, $n: Int!) {
  repository(owner: $o, name: $r) { pullRequest(number: $n) {
    comments(last: 50) { nodes { author { login } body createdAt url } }
    reviews(last: 30) { nodes { author { login } state body submittedAt url } }
    reviewThreads(last: 50) { nodes { isResolved isOutdated path line
      comments(first: 20) { nodes { author { login } body createdAt url } } } }
    commits(last: 30) { nodes { commit { oid messageHeadline committedDate url author { name user { login } } } } }
  } } }`

/** One comment: on the PR, or in a review thread. */
const commentNode = z.object({ author: actor, body: text, createdAt: text, url: text })

/** ACTIVITY_QUERY's answer. */
const activityAnswer = z.object({
  repository: z.object({
    pullRequest: z.object({
      comments: nodesOf(commentNode),
      reviews: nodesOf(z.object({ author: actor, state: text, body: text, submittedAt: text, url: text })),
      reviewThreads: nodesOf(
        z.object({
          isResolved: flag,
          isOutdated: flag,
          path: text,
          line: z.catch(z.nullable(z.number()), null),
          comments: nodesOf(commentNode)
        })
      ),
      commits: nodesOf(
        z.object({
          commit: orEmpty(z.object({ messageHeadline: text, committedDate: text, url: text, author: orEmpty(z.object({ name: text, user: actor })) }))
        })
      )
    })
  })
})

/** Everything said and pushed on the PR, oldest first. Reviews with no words and no verdict are dropped. */
export function parseActivity(data: unknown): ActivityItem[] {
  const read = activityAnswer.safeParse(data)

  if (!read.success) {
    return []
  }

  const p = read.data.repository.pullRequest
  const who = (n: { author: { login: string } }) => n.author.login || 'ghost'
  const items: ActivityItem[] = [
    ...p.comments.map(n => ({ at: n.createdAt, author: who(n), body: n.body, kind: 'comment' as const, url: n.url })),
    ...p.reviews
      .filter(n => n.body.trim() || n.state !== 'COMMENTED')
      .map(n => ({ at: n.submittedAt, author: who(n), body: n.body, kind: 'review' as const, state: n.state, url: n.url })),
    ...p.reviewThreads.flatMap(t => {
      const [first, ...rest] = t.comments

      return first
        ? [
            {
              at: first.createdAt,
              author: who(first),
              body: first.body,
              kind: 'thread' as const,
              line: t.line,
              outdated: t.isOutdated,
              path: t.path,
              replies: rest.map(n => ({ at: n.createdAt, author: who(n), body: n.body })),
              resolved: t.isResolved,
              url: first.url
            }
          ]
        : []
    }),
    ...p.commits.map(({ commit: c }) => ({
      at: c.committedDate,
      author: c.author.user.login || c.author.name || 'ghost',
      body: c.messageHeadline,
      kind: 'commit' as const,
      url: c.url
    }))
  ]

  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

// ── Files ─────────────────────────────────────────────────────────────────────────────────────

export interface PrFile {
  path: string
  status: string
  additions: number
  deletions: number
  /** The unified diff; absent for a binary or a too-large file. */
  patch?: string | undefined
  previous?: string | undefined
}

/** One row of `GET /pulls/{n}/files`. */
const fileRow = z.object({ filename: text, previous_filename: text, status: text, additions: count, deletions: count, patch: text })

/** A page of the files answer; a row that is not an object is dropped, and an answer that is not a list holds none. */
export function parseFiles(rows: unknown): PrFile[] {
  return rowsOf(fileRow, Array.isArray(rows) ? rows : []).map(r => ({
    additions: r.additions,
    deletions: r.deletions,
    patch: r.patch || undefined,
    path: r.filename,
    previous: r.previous_filename || undefined,
    status: r.status
  }))
}

/** The Actions run ids behind failed checks, for "Re-run failed jobs". */
export function failedRuns(checks: readonly Check[]): number[] {
  const ids = new Set<number>()

  for (const c of checks) {
    const id = c.status === 'failure' || c.status === 'cancelled' ? c.url?.match(/\/actions\/runs\/(\d+)/)?.[1] : undefined

    if (id) {
      ids.add(Number(id))
    }
  }

  return [...ids]
}
