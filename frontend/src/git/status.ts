// The session folder's git state for the sidebar and the Changes sheet, read as T3 Code reads a
// thread's (`git status --porcelain=2 --branch`, numstat against HEAD): the branch, its upstream and
// how far apart they are, and every changed file with its added and removed lines.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface ChangedFile {
  path: string
  /** Where a rename came from. */
  from?: string
  /** `modified`, `added`, `deleted`, `renamed`, `untracked`, `conflicted`. */
  status: string
  staged: boolean
  additions: number
  deletions: number
}

export interface GitState {
  /** The checkout's top folder. */
  root: string
  /** Undefined on a detached HEAD. */
  branch?: string
  upstream?: string
  ahead: number
  behind: number
  files: ChangedFile[]
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 })

  return stdout
}

const KIND: Record<string, string> = { A: 'added', C: 'copied', D: 'deleted', M: 'modified', R: 'renamed', T: 'modified' }

/**
 * `git status --porcelain=2 --branch -z`: the branch lines and one entry per changed path. `-z`
 * leaves paths raw (no C quoting of a non-ASCII or odd name) and gives a rename's origin as the
 * next NUL record.
 */
export function parseStatus(text: string): Omit<GitState, 'root'> {
  const state: Omit<GitState, 'root'> = { ahead: 0, behind: 0, files: [] }
  const records = text.split('\0')

  for (let i = 0; i < records.length; i++) {
    const line = records[i]!

    if (line.startsWith('# branch.head ')) {
      const head = line.slice(14)
      state.branch = head === '(detached)' ? undefined : head
    } else if (line.startsWith('# branch.upstream ')) {
      state.upstream = line.slice(18)
    } else if (line.startsWith('# branch.ab ')) {
      const [, a, b] = line.match(/\+(\d+) -(\d+)/) ?? []
      state.ahead = Number(a ?? 0)
      state.behind = Number(b ?? 0)
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const parts = line.split(' ')
      const xy = parts[1] ?? '..'
      const path = parts.slice(line.startsWith('1 ') ? 8 : 9).join(' ')
      const from = line.startsWith('2 ') ? records[++i] : undefined
      const code = xy[0] !== '.' ? xy[0]! : xy[1]!
      state.files.push({ additions: 0, deletions: 0, from, path, staged: xy[0] !== '.', status: KIND[code] ?? 'modified' })
    } else if (line.startsWith('u ')) {
      state.files.push({ additions: 0, deletions: 0, path: line.split(' ').slice(10).join(' '), staged: false, status: 'conflicted' })
    } else if (line.startsWith('? ')) {
      state.files.push({ additions: 0, deletions: 0, path: line.slice(2), staged: false, status: 'untracked' })
    }
  }

  return state
}

/** `git diff --numstat -z` records onto `files` (a binary file's `-` counts as 0). */
export function applyNumstat(files: ChangedFile[], text: string) {
  const byPath = new Map(files.map(f => [f.path, f]))
  const records = text.split('\0')

  for (let i = 0; i < records.length; i++) {
    const [add, del, ...rest] = records[i]!.split('\t')
    // A rename has an empty path, then two records: old and new. The new one is what status names.
    let path = rest.join('\t')

    if (rest.length && !path) {
      path = records[i + 2] ?? ''
      i += 2
    }

    const f = byPath.get(path)

    if (f) {
      f.additions = Number(add) || 0
      f.deletions = Number(del) || 0
    }
  }
}

/** The state of the checkout holding `cwd`; undefined outside git. */
export async function gitState(cwd: string): Promise<GitState | undefined> {
  try {
    const root = (await git(cwd, 'rev-parse', '--show-toplevel')).trim()
    const state = parseStatus(await git(root, 'status', '--porcelain=2', '--branch', '--untracked-files=all', '-z'))
    // Against HEAD: staged and unstaged together. A repository with no commit yet has no HEAD.
    const numstat = await git(root, 'diff', '--numstat', '-z', '-M', 'HEAD').catch(() => '')
    applyNumstat(state.files, numstat)

    // A new file's lines are all added; count them for the first few.
    for (const f of state.files.filter(x => x.status === 'untracked').slice(0, 50)) {
      const out = await git(root, 'diff', '--no-index', '--numstat', '-z', '--', '/dev/null', f.path).catch((e: { stdout?: string }) => e.stdout ?? '')
      // `--no-index` exits 1 when they differ; its numstat reads as a rename from `/dev/null`.
      applyNumstat([f], out)
    }

    return { root, ...state }
  } catch {
    return undefined
  }
}

/** The diff of one file against HEAD (an untracked one against nothing). */
export async function fileDiff(root: string, f: ChangedFile): Promise<string> {
  if (f.status === 'untracked') {
    // `--no-index` exits 1 when the files differ, which they always do here.
    return git(root, 'diff', '--no-index', '--', '/dev/null', f.path).catch((e: { stdout?: string }) => e.stdout ?? '')
  }

  return git(root, 'diff', '-M', 'HEAD', '--', ...(f.from ? [f.from, f.path] : [f.path])).catch(() => '')
}
