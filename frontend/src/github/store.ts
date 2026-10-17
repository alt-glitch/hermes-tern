// The session's pull requests for the PR pill and sheet: the PRs the agent linked, each read from
// GitHub. Polling only, as T3 Code does: every minute while one is open, every 30 s while its
// checks run, and at once when the sheet opens or a PR is linked. Comments and files are read when
// the sheet shows them.

import type { ToolCall } from '../model.js'

import { type GitHub, github } from './client.js'
import { linkedFromResult, prKey, storedLinks } from './links.js'
import {
  ACTIVITY_QUERY,
  type ActivityItem,
  batchQuery,
  checksState,
  failedRuns,
  type MergeMethod,
  parseActivity,
  parseFiles,
  parsePullRequest,
  type PrFile,
  type PrRef,
  type PullRequest
} from './pullRequest.js'

export const OPEN_MS = 60_000
export const PENDING_MS = 30_000
/** At most this many PRs in one GraphQL request. */
const BATCH = 20

export interface PullRequestsHost {
  /** The session the links belong to (the stored session id the link tools see). */
  sid(): string | null
  changed(): void
}

/** What the sheet knows of one linked PR. */
export interface Entry {
  ref: PrRef
  pr?: PullRequest
  /** GitHub's answer when it could not read this PR. */
  error?: string
  activity?: ActivityItem[]
  files?: PrFile[]
  /** The `updatedAt` the activity and files were read at; a newer PR reads them again. */
  detailAt?: string
}

export type PrAction = 'close' | 'draft' | 'merge' | 'ready' | 'reopen' | 'rerun' | 'update-branch'

const MUTATIONS: Partial<Record<PrAction, string>> = {
  close: 'mutation($id: ID!) { closePullRequest(input: {pullRequestId: $id}) { clientMutationId } }',
  draft: 'mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { clientMutationId } }',
  merge:
    'mutation($id: ID!, $m: PullRequestMergeMethod!, $oid: GitObjectID) { mergePullRequest(input: {pullRequestId: $id, mergeMethod: $m, expectedHeadOid: $oid}) { clientMutationId } }',
  ready: 'mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { clientMutationId } }',
  reopen: 'mutation($id: ID!) { reopenPullRequest(input: {pullRequestId: $id}) { clientMutationId } }',
  'update-branch':
    'mutation($id: ID!, $oid: GitObjectID) { updatePullRequestBranch(input: {pullRequestId: $id, expectedHeadOid: $oid}) { clientMutationId } }'
}

export class PullRequests {
  readonly #host: PullRequestsHost
  readonly #gh: GitHub
  readonly #links: (sid: string) => PrRef[]
  #sid: string | null = null
  #refs: PrRef[] = []
  readonly #entries = new Map<string, Entry>()
  /** Why nothing could be read at all (no token). */
  #error: string | undefined
  #timer: NodeJS.Timeout | undefined
  #loading = false
  #again = false
  #disposed = false
  readonly #busy = new Set<string>()

  constructor(host: PullRequestsHost, gh: GitHub = github(), links: (sid: string) => PrRef[] = sid => storedLinks(sid)) {
    this.#host = host
    this.#gh = gh
    this.#links = links
  }

  /** The linked PRs, oldest link first. */
  entries(): Entry[] {
    return this.#refs.map(ref => this.#entry(ref))
  }

  get(key: string): Entry | undefined {
    return this.#entries.get(key)
  }

  get error(): string | undefined {
    return this.#error
  }

  get loading(): boolean {
    return this.#loading
  }

  busy(key: string): boolean {
    return this.#busy.has(key)
  }

  /** A session was adopted (a resume, a switch): its stored links replace the old ones. */
  adopt() {
    const sid = this.#host.sid()

    if (sid === this.#sid) {
      return
    }

    this.#sid = sid
    this.#refs = sid ? this.#links(sid) : []
    this.#host.changed()
    this.poke()
  }

  /** A finished tool call: a link tool's result is the conversation's whole list. */
  onCall(call: ToolCall) {
    const linked = linkedFromResult(call)

    if (!linked) {
      return
    }

    const before = this.#refs.map(prKey).join()
    this.#refs = linked

    if (linked.map(prKey).join() !== before) {
      this.#host.changed()
      this.poke()
    }
  }

  /** Reads every linked PR now. */
  poke() {
    clearTimeout(this.#timer)
    this.#timer = undefined
    void this.#tick()
  }

  dispose() {
    this.#disposed = true
    clearTimeout(this.#timer)
  }

  /** Comments, reviews and commits of `key`, read once per PR update. */
  async activity(key: string): Promise<void> {
    const e = this.#entries.get(key)

    if (!e?.pr || (e.activity && e.detailAt === e.pr.updatedAt)) {
      return
    }

    const [o, r] = e.ref.repository.split('/')
    const data = await this.#gh.graphql(e.ref.host, ACTIVITY_QUERY, { n: e.ref.number, o, r })
    e.activity = parseActivity(data)
    e.detailAt = e.pr.updatedAt
    this.#host.changed()
  }

  /** The changed files of `key` with their patches (the first 300). */
  async files(key: string): Promise<void> {
    const e = this.#entries.get(key)

    if (!e?.pr || (e.files && e.detailAt === e.pr.updatedAt)) {
      return
    }

    const files: PrFile[] = []

    for (let page = 1; page <= 3; page++) {
      const rows = await this.#gh.rest<unknown[]>(e.ref.host, 'GET', `/repos/${e.ref.repository}/pulls/${e.ref.number}/files?per_page=100&page=${page}`)
      files.push(...parseFiles(rows))

      if (rows.length < 100) {
        break
      }
    }

    e.files = files
    this.#host.changed()
  }

  /** Changes PR `key` on GitHub; throws GitHub's error. `merge` uses `method`, the repository's first by default. */
  async act(action: PrAction, key: string, method?: MergeMethod): Promise<void> {
    const pr = this.#entries.get(key)?.pr

    if (!pr) {
      throw new Error('That pull request has not loaded yet.')
    }

    this.#busy.add(key)
    this.#host.changed()

    try {
      if (action === 'rerun') {
        const runs = failedRuns(pr.checks)

        if (!runs.length) {
          throw new Error('No failed GitHub Actions run to re-run.')
        }

        for (const id of runs) {
          await this.#gh.rest(pr.host, 'POST', `/repos/${pr.repository}/actions/runs/${id}/rerun-failed-jobs`)
        }
      } else {
        await this.#gh.graphql(pr.host, MUTATIONS[action]!, {
          id: pr.id,
          ...(action === 'merge' ? { m: (method ?? pr.mergeMethods[0] ?? 'merge').toUpperCase(), oid: pr.headOid } : {}),
          ...(action === 'update-branch' ? { oid: pr.headOid } : {})
        })
      }
    } finally {
      this.#busy.delete(key)
      this.poke()
    }
  }

  #entry(ref: PrRef): Entry {
    const key = prKey(ref)
    let e = this.#entries.get(key)

    if (!e) {
      e = { ref }
      this.#entries.set(key, e)
    }

    return e
  }

  #schedule() {
    clearTimeout(this.#timer)
    const open = this.entries().filter(e => !e.pr || e.pr.state === 'open')

    if (this.#disposed || !open.length) {
      return
    }

    const pending = open.some(e => e.pr && checksState(e.pr.checks) === 'pending')
    this.#timer = setTimeout(() => void this.#tick(), pending ? PENDING_MS : OPEN_MS)
  }

  async #tick() {
    if (this.#loading) {
      this.#again = true

      return
    }

    this.#loading = true

    try {
      do {
        this.#again = false
        await this.#read()
      } while (this.#again)
    } finally {
      this.#loading = false
      this.#schedule()
      this.#host.changed()
    }
  }

  async #read() {
    const entries = this.entries()
    const byHost = new Map<string, Entry[]>()

    for (const e of entries) {
      byHost.set(e.ref.host, [...(byHost.get(e.ref.host) ?? []), e])
    }

    let failed: string | undefined

    for (const [host, list] of byHost) {
      for (let i = 0; i < list.length; i += BATCH) {
        const chunk = list.slice(i, i + BATCH)
        const { query, variables } = batchQuery(chunk.map(e => e.ref))

        try {
          const data = await this.#gh.graphql<Record<string, unknown>>(host, query, variables)

          chunk.forEach((e, j) => {
            const pr = parsePullRequest(e.ref, data[`p${j}`])
            e.pr = pr ?? e.pr
            e.error = pr ? undefined : 'GitHub has no such pull request, or this token cannot see it.'
          })
        } catch (error) {
          failed = error instanceof Error ? error.message : String(error)
          chunk.forEach(e => (e.error = failed))
        }
      }
    }

    // One error for all of them (no token) says so once; a PR of its own failing does not.
    this.#error = entries.length && entries.every(e => e.error && !e.pr) ? failed : undefined
  }
}
