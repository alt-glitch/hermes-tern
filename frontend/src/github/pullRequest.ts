// A pull request as the sheet shows it, read from GitHub's GraphQL API. The fields and the check
// mapping follow T3 Code's PullRequestCore query and gitHubPullRequestJson.ts (MIT, T3 Tools Inc.),
// cut down to what a terminal sheet draws.

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
  workflow?: string
  status: CheckStatus
  url?: string
  description?: string
  startedAt?: string
  completedAt?: string
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

// ── Parsing ───────────────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>

const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const nodes = (v: unknown): Json[] => {
  const list = obj(v)?.nodes

  return Array.isArray(list) ? list.map(obj).filter((x): x is Json => Boolean(x)) : []
}

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

export function parseCheck(n: Json): Check {
  if (n.__typename === 'StatusContext') {
    return {
      description: str(n.description) || undefined,
      name: str(n.context),
      startedAt: str(n.createdAt) || undefined,
      status: checkStatus('COMPLETED', str(n.state)),
      url: str(n.targetUrl) || undefined
    }
  }

  const workflow = str(obj(obj(obj(n.checkSuite)?.workflowRun)?.workflow)?.name)

  return {
    completedAt: str(n.completedAt) || undefined,
    name: str(n.name),
    startedAt: str(n.startedAt) || undefined,
    status: checkStatus(str(n.status), str(n.conclusion)),
    url: str(n.detailsUrl) || undefined,
    workflow: workflow || undefined
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
  const r = obj(repo)
  const p = obj(r?.pullRequest)

  if (!r || !p) {
    return undefined
  }

  const reviews = new Map<string, string>()

  for (const n of nodes(p.reviewRequests)) {
    const who = obj(n.requestedReviewer)
    const login = str(who?.login) || str(who?.name)

    if (login) {
      reviews.set(login, 'PENDING')
    }
  }

  // Someone who reviewed drops off reviewRequests: their latest review stands for them.
  for (const n of nodes(p.latestReviews)) {
    const login = str(obj(n.author)?.login)

    if (login && !reviews.has(login)) {
      reviews.set(login, str(n.state))
    }
  }

  const rollup = obj(obj(obj(nodes(p.commits)[0]?.commit)?.statusCheckRollup)?.contexts)
  const methods: MergeMethod[] = [
    ...(r.squashMergeAllowed ? (['squash'] as const) : []),
    ...(r.mergeCommitAllowed ? (['merge'] as const) : []),
    ...(r.rebaseMergeAllowed ? (['rebase'] as const) : [])
  ]
  const behind = obj(obj(p.baseRef)?.compare)?.behindBy

  return {
    ...ref,
    additions: num(p.additions),
    author: str(obj(p.author)?.login) || 'ghost',
    autoMerge: str(obj(p.autoMergeRequest)?.mergeMethod) || null,
    base: str(p.baseRefName),
    behindBy: typeof behind === 'number' ? behind : null,
    body: str(p.body),
    canUpdate: p.viewerCanUpdate === true,
    changedFiles: num(p.changedFiles),
    checks: dedupeChecks(nodes(rollup).map(parseCheck)),
    closedAt: str(p.closedAt) || null,
    createdAt: str(p.createdAt),
    deletions: num(p.deletions),
    draft: p.isDraft === true,
    head: str(p.headRefName),
    headOid: str(p.headRefOid),
    id: str(p.id),
    labels: nodes(p.labels).map(n => str(n.name)),
    mergeMethods: methods,
    mergeState: str(p.mergeStateStatus),
    mergeable: MERGEABLE[str(p.mergeable)] ?? 'unknown',
    mergedAt: str(p.mergedAt) || null,
    reviewDecision: str(p.reviewDecision) || null,
    reviewers: [...reviews].map(([login, state]) => ({ login, state })),
    state: STATE[str(p.state)] ?? 'open',
    title: str(p.title),
    updatedAt: str(p.updatedAt),
    url: str(p.url) || ref.url
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

/** Everything said and pushed on the PR, oldest first. Reviews with no words and no verdict are dropped. */
export function parseActivity(data: unknown): ActivityItem[] {
  const p = obj(obj(obj(data)?.repository)?.pullRequest)

  if (!p) {
    return []
  }

  const who = (n: Json) => str(obj(n.author)?.login) || 'ghost'
  const items: ActivityItem[] = [
    ...nodes(p.comments).map(n => ({ at: str(n.createdAt), author: who(n), body: str(n.body), kind: 'comment' as const, url: str(n.url) })),
    ...nodes(p.reviews)
      .filter(n => str(n.body).trim() || str(n.state) !== 'COMMENTED')
      .map(n => ({ at: str(n.submittedAt), author: who(n), body: str(n.body), kind: 'review' as const, state: str(n.state), url: str(n.url) })),
    ...nodes(p.reviewThreads).flatMap(t => {
      const [first, ...rest] = nodes(t.comments)

      return first
        ? [
            {
              at: str(first.createdAt),
              author: who(first),
              body: str(first.body),
              kind: 'thread' as const,
              line: typeof t.line === 'number' ? t.line : null,
              outdated: t.isOutdated === true,
              path: str(t.path),
              replies: rest.map(n => ({ at: str(n.createdAt), author: who(n), body: str(n.body) })),
              resolved: t.isResolved === true,
              url: str(first.url)
            }
          ]
        : []
    }),
    ...nodes(p.commits).map(n => {
      const c = obj(n.commit) ?? {}
      const a = obj(c.author)

      return {
        at: str(c.committedDate),
        author: str(obj(a?.user)?.login) || str(a?.name) || 'ghost',
        body: str(c.messageHeadline),
        kind: 'commit' as const,
        url: str(c.url)
      }
    })
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
  patch?: string
  previous?: string
}

export function parseFiles(rows: unknown): PrFile[] {
  return (Array.isArray(rows) ? rows : [])
    .map(obj)
    .filter((r): r is Json => Boolean(r))
    .map(r => ({
      additions: num(r.additions),
      deletions: num(r.deletions),
      patch: str(r.patch) || undefined,
      path: str(r.filename),
      previous: str(r.previous_filename) || undefined,
      status: str(r.status)
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
