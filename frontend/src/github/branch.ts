// The PR of the session's branch, as T3 Code finds a thread's (GitManager.lookupBranchPullRequest):
// the checkout's branch and its upstream, the GitHub repository of that remote, then the newest
// open PR whose head is that branch (else the newest one). The default branch has none.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { type StackKey, stackKey } from '../core/ids.js'

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
  const m =
    url.match(/^[\w.-]+@([^:/]+):([^/]+\/[^/]+?)(?:\.git)?\/?$/) ??
    url.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+\/[^/]+?)(?:\.git)?\/?$/)

  if (!m) {
    return undefined
  }

  const host = m[1]!.toLowerCase()

  return host === 'github.com' || host.split('.').includes('github') ? { host, repository: m[2]!.toLowerCase() } : undefined
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

interface ByHead {
  repository?: { pullRequests?: { nodes?: { number: number; url: string; state: string; headRepositoryOwner?: { login?: string } | null }[] } } | null
}

/** The branch's PR: the newest open one, else the newest of any state (T3 Code's findLatestPrForHeadContext). */
export async function branchPullRequest(gh: GitHub, target: BranchTarget): Promise<PrRef | undefined> {
  const [o, r] = target.repository.split('/')
  const data = await gh.graphql<ByHead>(target.host, BY_HEAD, { h: target.head, o, r })
  // A fork's branch of the same name is not this one.
  const prs = (data.repository?.pullRequests?.nodes ?? []).filter(p => (p.headRepositoryOwner?.login ?? '').toLowerCase() === o)
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

/** `GET /repos/{repo}/stacks?pull_request=N`, decoded as T3 Code's decodePullRequestStacksJson does. */
export function parseStacks(host: string, repository: string, rows: unknown): Stack[] {
  return (Array.isArray(rows) ? rows : []).flatMap(row => {
    const s = row as { number?: number; base?: string | { ref?: string }; pull_requests?: { number?: number; head?: { ref?: string }; state?: string; merged_at?: string | null }[] }

    if (typeof s?.number !== 'number' || !Array.isArray(s.pull_requests)) {
      return []
    }

    return [
      {
        base: typeof s.base === 'string' ? s.base : (s.base?.ref ?? ''),
        host,
        key: stackKey(host, repository, s.number),
        layers: s.pull_requests
          .filter(p => typeof p.number === 'number')
          .map(p => ({ head: p.head?.ref ?? '', number: p.number!, state: p.merged_at ? 'merged' : (p.state ?? 'open') })),
        number: s.number,
        repository
      }
    ]
  })
}
