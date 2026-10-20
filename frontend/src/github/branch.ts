// The PR of the session's branch, as T3 Code finds a thread's (GitManager.lookupBranchPullRequest):
// the checkout's branch and its upstream, the GitHub repository of that remote, then the newest
// open PR whose head is that branch (else the newest one). The default branch has none.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import * as z from 'zod/mini'

import { type StackKey, stackKey } from '../core/ids.js'
import { rowsOf } from '../wire/schemas.js'

import type { GitHub } from './client.js'
import type { PrRef } from './pullRequest.js'

const run = promisify(execFile)

export interface BranchTarget {
  host: string
  /** `owner/repo` of the remote the branch pushes to, lower case. */
  repository: string
  /** The branch name on that remote. */
  head: string
}

/** `git@github.com:Owner/Repo.git`, `https://github.com/owner/repo`, `ssh://git@host/o/r.git` → host and repo. */
export function parseRemote(url: string): { host: string; repository: string } | undefined {
  const m = (
    /^[\w.-]+@(?<host>[^:/]+):(?<repo>[^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url) ??
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?(?<host>[^/:]+)(?::\d+)?\/(?<repo>[^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)
  )?.groups

  if (!m) {
    return undefined
  }

  const host = (m['host'] ?? '').toLowerCase()

  return host === 'github.com' || host.split('.').includes('github') ? { host, repository: (m['repo'] ?? '').toLowerCase() } : undefined
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 5000 })

  return stdout.trim()
}

/** Where the checkout at `cwd` pushes its branch; undefined off a branch, on the default branch, or off GitHub. */
export async function branchTarget(cwd: string): Promise<BranchTarget | undefined> {
  try {
    const branch = await git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD')
    const [remote = '', ref = ''] = (
      await git(cwd, 'for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', `refs/heads/${branch}`)
    ).split('\u0000')
    const name = remote || 'origin'
    const parsed = parseRemote(await git(cwd, 'remote', 'get-url', name))
    const head = ref.replace(/^refs\/heads\//, '') || branch
    const fallback = ['main', 'master']
    const defaultBranch = (await git(cwd, 'symbolic-ref', '--quiet', '--short', `refs/remotes/${name}/HEAD`).catch(() => '')).replace(
      `${name}/`,
      ''
    )

    if (!parsed || !head || (defaultBranch ? head === defaultBranch : fallback.includes(head))) {
      return undefined
    }

    return { ...parsed, head }
  } catch {
    // Not a git checkout, a detached HEAD, no such remote.
    return undefined
  }
}

const BY_HEAD = `query($o: String!, $r: String!, $h: String!) {
  repository(owner: $o, name: $r) {
    pullRequests(headRefName: $h, first: 10, orderBy: {field: UPDATED_AT, direction: DESC}, states: [OPEN, MERGED, CLOSED]) {
      nodes { number url state headRepositoryOwner { login } }
    }
  }
}`

/** One PR of the branch's name; its owner's login is '' when GitHub names none. */
const headNode = z.object({
  number: z.number(),
  url: z.string(),
  state: z.catch(z.string(), ''),
  headRepositoryOwner: z.catch(z.object({ login: z.catch(z.string(), '') }), { login: '' })
})

/** BY_HEAD's answer. A repository or list GitHub did not send reads as no PRs; a node it cannot read throws, as it did before the schema. */
const byHead = z.object({
  repository: z.nullish(z.object({ pullRequests: z.nullish(z.object({ nodes: z.nullish(z.array(headNode)) })) }))
})

/** The branch's PR: the newest open one, else the newest of any state (T3 Code's findLatestPrForHeadContext). */
export async function branchPullRequest(gh: GitHub, target: BranchTarget): Promise<PrRef | undefined> {
  const [o, r] = target.repository.split('/')
  const data = byHead.parse(await gh.graphql(target.host, BY_HEAD, { h: target.head, o, r }))
  // A fork's branch of the same name is not this one.
  const prs = (data.repository?.pullRequests?.nodes ?? []).filter(p => p.headRepositoryOwner.login.toLowerCase() === o)
  const pr = prs.find(p => p.state === 'OPEN') ?? prs[0]

  return pr ? { host: target.host, number: pr.number, repository: target.repository, url: pr.url } : undefined
}

// ── Stacks (GitHub's stacked pull requests) ───────────────────────────────────────────────────

export interface Stack {
  key: StackKey
  host: string
  repository: string
  number: number
  base: string
  /** Bottom first. */
  layers: { number: number; head: string; state: string }[]
}

/** Which of `refs` sit in a native stack; github.com only (GHES lacks the fields). */
export function stackQuery(refs: readonly PrRef[]): { query: string; variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = {}
  const decls: string[] = []
  const parts = refs.map((ref, i) => {
    const [owner, name] = ref.repository.split('/')
    variables[`o${i}`] = owner
    variables[`r${i}`] = name
    variables[`n${i}`] = ref.number
    decls.push(`$o${i}: String!, $r${i}: String!, $n${i}: Int!`)

    return `p${i}: repository(owner: $o${i}, name: $r${i}) { pullRequest(number: $n${i}) { stack { number } } }`
  })

  return { query: `query(${decls.join(', ')}) { ${parts.join('\n')} }`, variables }
}

/** One alias of the stack query: its PR, in the stack it sits in. */
const member = z.object({ pullRequest: z.object({ stack: z.object({ number: z.number() }) }) })

/** The number of the stack one alias's PR sits in; undefined for none (or an answer that says nothing). */
export function stackNumber(alias: unknown): number | undefined {
  return member.safeParse(alias).data?.pullRequest.stack.number
}

/** One stack of the answer; one with no number or no list of PRs is skipped. */
const stackRow = z.object({
  number: z.number(),
  /** The branch the stack sits on: a name, or a ref object. */
  base: z.catch(z.union([z.string(), z.pipe(z.object({ ref: z.catch(z.string(), '') }), z.transform(b => b.ref))]), ''),
  pull_requests: z.array(z.unknown())
})

/** One layer of a stack, bottom first; one with no number is skipped. */
const layerRow = z.object({
  number: z.number(),
  head: z.catch(z.object({ ref: z.catch(z.string(), '') }), { ref: '' }),
  state: z.catch(z.string(), 'open'),
  merged_at: z.optional(z.unknown())
})

/**
 * A stack's layer; undefined for one with no number. A null layer throws, as reading its number
 * did before the schema: the caller then keeps the stack it had.
 */
function layerOf(raw: unknown): Stack['layers'][number] | undefined {
  if (raw === null) {
    throw new TypeError('A stack layer is null')
  }

  const p = layerRow.safeParse(raw).data

  return p && { head: p.head.ref, number: p.number, state: p.merged_at ? 'merged' : p.state }
}

/** `GET /repos/{repo}/stacks?pull_request=N`, decoded as T3 Code's decodePullRequestStacksJson does. */
export function parseStacks(host: string, repository: string, rows: unknown): Stack[] {
  return rowsOf(stackRow, Array.isArray(rows) ? rows : []).map(s => ({
    base: s.base,
    host,
    key: stackKey(host, repository, s.number),
    layers: s.pull_requests.flatMap(p => layerOf(p) ?? []),
    number: s.number,
    repository
  }))
}
