// The session's pull requests for the PR pill and sheet: the PRs the agent linked, the PR of the
// session's branch (its checkout or worktree), and the other layers of a GitHub stack any of them
// sits in, each read from GitHub. Polling only, as T3 Code does: every minute while one is open, every 30 s while its
// checks run, and at once when the sheet opens or a PR is linked. Comments and files are read when
// the sheet shows them.

import { errorText } from '../core/errors.js'
import type { ToolCall } from '../model.js'

import { type BranchTarget, branchPullRequest, branchTarget, parseStacks, type Stack, stackQuery } from './branch.js'
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
  /** The session's working directory, for its branch's PR. */
  cwd(): string | null
  changed(): void
}

/** How a PR came to be on the list. */
export type Source = 'branch' | 'linked' | 'stack'

/** How long the branch's PR lookup is trusted (T3 Code: 60 s with a PR, 5 min without). */
const BRANCH_HIT_MS = 60_000
const BRANCH_MISS_MS = 300_000

/** GraphQL's answer when the schema has no `stack` field (GHES, an older API). */
const NO_STACK_FIELD = /Field '?stack'? doesn't exist/i

/** What the sheet knows of one linked PR. */
export interface Entry {
  ref: PrRef
  source: Source
  /** The native stack it is a layer of. */
  stack?: Stack
  pr?: PullRequest
  /** GitHub's answer when it could not read this PR. */
  error?: string
  activity?: ActivityItem[]
  files?: PrFile[]
  /** The `updatedAt` the activity was read at; a newer PR reads it again. */
  activityAt?: string
  /** The `updatedAt` the files were read at, kept apart: one tab's read says nothing of the other. */
  filesAt?: string
  /** GitHub's answer when the last activity read failed. */
  activityError?: string
  /** GitHub's answer when the last files read failed. */
  filesError?: string
}

/** The data a tab reads on demand. */
type Detail = 'activity' | 'files'

const STAMP = { activity: 'activityAt', files: 'filesAt' } as const
const FAILURE = { activity: 'activityError', files: 'filesError' } as const
/** How soon a failed activity or files read is tried again. */
const RETRY_MS = 30_000

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
  #branch: { at: number; cwd: string; ref?: PrRef; target?: BranchTarget } | undefined
  /** Native stacks by key, from the PRs' stack membership. */
  readonly #stacks = new Map<string, Stack>()
  /** Hosts whose GraphQL has no stack fields (GHES): not asked again. */
  readonly #noStacks = new Set<string>()
  readonly #branchOf: (cwd: string) => Promise<BranchTarget | undefined>
  /** Why nothing could be read at all (no token). */
  #error: string | undefined
  #timer: NodeJS.Timeout | undefined
  #loading = false
  #again = false
  #disposed = false
  readonly #busy = new Set<string>()
  /** The activity and files reads in flight (`key:activity`, `key:files`). */
  readonly #reading = new Set<string>()
  /** When each of those last failed. */
  readonly #failedAt = new Map<string, number>()

  constructor(
    host: PullRequestsHost,
    gh: GitHub = github(),
    links: (sid: string) => PrRef[] = sid => storedLinks(sid),
    branchOf: (cwd: string) => Promise<BranchTarget | undefined> = branchTarget
  ) {
    this.#host = host
    this.#gh = gh
    this.#links = links
    this.#branchOf = branchOf
  }

  /** The linked PRs (oldest link first), then the branch's PR, then stack layers none of them are. */
  entries(): Entry[] {
    const seen = new Set<string>()
    const out: Entry[] = []
    const add = (ref: PrRef, source: Source) => {
      const key = prKey(ref)

      if (!seen.has(key)) {
        seen.add(key)
        const e = this.#entry(ref)
        e.source = source
        out.push(e)
      }
    }

    this.#refs.forEach(r => add(r, 'linked'))

    if (this.#branch?.ref) {
      add(this.#branch.ref, 'branch')
    }

    const inStack = (s: Stack, ref: PrRef) => ref.host === s.host && ref.repository === s.repository && s.layers.some(l => l.number === ref.number)

    for (const s of this.#stacks.values()) {
      if (out.some(e => inStack(s, e.ref))) {
        s.layers.forEach(l => add({ host: s.host, number: l.number, repository: s.repository, url: `https://${s.host}/${s.repository}/pull/${l.number}` }, 'stack'))
      }
    }

    for (const e of out) {
      e.stack = [...this.#stacks.values()].find(s => inStack(s, e.ref))
    }

    return out
  }

  /** The native stacks the list's PRs sit in. */
  stacks(): Stack[] {
    return [...this.#stacks.values()]
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
    this.#branch = undefined
    this.#stacks.clear()
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

  /**
   * Reads the stored links again. A subagent runs in a session of its own and links under this
   * conversation (pull_requests.py), with no link result in this transcript.
   */
  relink() {
    const sid = this.#host.sid()

    if (!sid || sid !== this.#sid) {
      return
    }

    const linked = this.#links(sid)

    if (linked.map(prKey).join() !== this.#refs.map(prKey).join()) {
      this.#refs = linked
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
  activity(key: string): Promise<void> {
    return this.#detail(key, 'activity', async e => {
      const [o, r] = e.ref.repository.split('/')
      e.activity = parseActivity(await this.#gh.graphql(e.ref.host, ACTIVITY_QUERY, { n: e.ref.number, o, r }))
    })
  }

  /** The changed files of `key` with their patches (the first 300). */
  files(key: string): Promise<void> {
    return this.#detail(key, 'files', async e => {
      const files: PrFile[] = []

      for (let page = 1; page <= 3; page++) {
        const rows = await this.#gh.rest<unknown[]>(e.ref.host, 'GET', `/repos/${e.ref.repository}/pulls/${e.ref.number}/files?per_page=100&page=${page}`)
        files.push(...parseFiles(rows))

        if (rows.length < 100) {
          break
        }
      }

      e.files = files
    })
  }

  /**
   * Reads one tab's data of `key` once per PR update, so the sheet may ask on every frame: one read
   * at a time, and a failed one (its error on the entry) again after `RETRY_MS`.
   */
  async #detail(key: string, what: Detail, read: (e: Entry) => Promise<void>): Promise<void> {
    const e = this.#entries.get(key)
    const id = `${key}:${what}`
    const failed = this.#failedAt.get(id)

    if (!e?.pr || this.#reading.has(id) || (e[what] && e[STAMP[what]] === e.pr.updatedAt) || (failed && Date.now() - failed < RETRY_MS)) {
      return
    }

    const at = e.pr.updatedAt
    this.#reading.add(id)

    try {
      await read(e)
      e[STAMP[what]] = at
      e[FAILURE[what]] = undefined
      this.#failedAt.delete(id)
    } catch (error) {
      e[FAILURE[what]] = errorText(error)
      this.#failedAt.set(id, Date.now())
      throw error
    } finally {
      this.#reading.delete(id)
      this.#host.changed()
    }
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
      e = { ref, source: 'linked' }
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

  /** The branch's PR, looked up again once its last answer is old or the session moved. */
  async #readBranch() {
    const cwd = this.#host.cwd()
    const now = Date.now()
    const b = this.#branch

    if (!cwd) {
      this.#branch = undefined

      return
    }

    const target = await this.#branchOf(cwd)
    const same = b && b.cwd === cwd && b.target?.head === target?.head && b.target?.repository === target?.repository

    if (same && now - b.at < (b.ref ? BRANCH_HIT_MS : BRANCH_MISS_MS)) {
      return
    }

    let ref: PrRef | undefined

    try {
      ref = target ? await branchPullRequest(this.#gh, target) : undefined
    } catch {
      // No token or no network: the linked PRs say why.
      ref = same ? b.ref : undefined
    }

    this.#branch = { at: now, cwd, ref, target }
  }

  /** Which PRs sit in a GitHub stack, and that stack's layers; new layers are read next round. */
  async #readStacks(entries: Entry[]): Promise<boolean> {
    const before = [...this.#stacks.keys()].join()
    const byHost = new Map<string, Entry[]>()

    for (const e of entries) {
      if (e.pr && !this.#noStacks.has(e.ref.host) && e.ref.host === 'github.com') {
        byHost.set(e.ref.host, [...(byHost.get(e.ref.host) ?? []), e])
      }
    }

    for (const [host, list] of byHost) {
      const { query, variables } = stackQuery(list.slice(0, BATCH).map(e => e.ref))
      let data: Record<string, { pullRequest?: { stack?: { number?: number } | null } | null } | null>

      try {
        data = await this.#gh.graphql(host, query, variables)
      } catch (error) {
        // Only a schema without the field turns stacks off; a timeout, a 5xx or a rate limit tries again next round.
        if (NO_STACK_FIELD.test(errorText(error))) {
          this.#noStacks.add(host)
        }

        continue
      }

      const asked = new Set<string>()

      for (const [i, e] of list.slice(0, BATCH).entries()) {
        const n = data[`p${i}`]?.pullRequest?.stack?.number
        const key = `${host}/${e.ref.repository}#stack:${n}`

        if (typeof n !== 'number' || asked.has(key)) {
          continue
        }

        asked.add(key)

        try {
          const rows = await this.#gh.rest(host, 'GET', `/repos/${e.ref.repository}/stacks?pull_request=${e.ref.number}`)
          parseStacks(host, e.ref.repository, rows).forEach(s => this.#stacks.set(s.key, s))
        } catch {
          // A stack we cannot read stays a single PR.
        }
      }
    }

    return [...this.#stacks.keys()].join() !== before
  }

  async #read() {
    await this.#readBranch()
    await this.#readPrs()

    // Stack layers not read yet: read them now, once.
    if (await this.#readStacks(this.entries())) {
      await this.#readPrs()
    }
  }

  async #readPrs() {
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
          failed = errorText(error)
          chunk.forEach(e => (e.error = failed))
        }
      }
    }

    // One error for all of them (no token) says so once; a PR of its own failing does not.
    this.#error = entries.length && entries.every(e => e.error && !e.pr) ? failed : undefined
  }
}
