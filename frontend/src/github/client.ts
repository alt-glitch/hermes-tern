// GitHub over HTTPS with the user's own token, as T3 Code reads it (GitHubCredentials.ts): GH_TOKEN
// or GITHUB_TOKEN, else `gh auth token` for the host. No token, no PR data: callers show why.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Why GitHub could not answer, in words for the sheet. */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

export interface GitHub {
  graphql<T>(host: string, query: string, variables?: Record<string, unknown>): Promise<T>
  rest<T>(host: string, method: string, path: string, body?: unknown): Promise<T>
}

const api = (host: string) => (host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`)
const graphqlUrl = (host: string) => (host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`)

/** The token for `host`; cached, so `gh` runs once per host. */
export function tokens(env: NodeJS.ProcessEnv = process.env): (host: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>()

  return host => {
    let token = cache.get(host)

    if (!token) {
      token = read(host, env)
      cache.set(host, token)
      // A failure (gh missing, logged out) is asked again next time.
      token.catch(() => cache.delete(host))
    }

    return token
  }
}

async function read(host: string, env: NodeJS.ProcessEnv): Promise<string> {
  const own = host === 'github.com' ? env.GH_TOKEN || env.GITHUB_TOKEN : env.GH_ENTERPRISE_TOKEN || env.GITHUB_ENTERPRISE_TOKEN

  if (own) {
    return own
  }

  try {
    const { stdout } = await run('gh', ['auth', 'token', '--hostname', host], { timeout: 10_000 })
    const token = stdout.trim()

    if (token) {
      return token
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new GitHubError('The GitHub CLI (gh) is not installed. Install it and run `gh auth login`, or set GH_TOKEN.')
    }
  }

  throw new GitHubError(`Not logged in to ${host}. Run \`gh auth login --hostname ${host}\`, or set GH_TOKEN.`)
}

export function github(token = tokens()): GitHub {
  async function call<T>(host: string, url: string, init: RequestInit): Promise<T> {
    const res = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${await token(host)}`,
        'User-Agent': 'hermes-tern',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {})
      },
      signal: AbortSignal.timeout(30_000)
    })

    const text = await res.text()
    const json = text ? (JSON.parse(text) as unknown) : undefined

    if (!res.ok) {
      const message = (json as { message?: string } | undefined)?.message

      throw new GitHubError(message ? `GitHub: ${message}` : `GitHub answered ${res.status}`, res.status)
    }

    return json as T
  }

  return {
    async graphql<T>(host: string, query: string, variables: Record<string, unknown> = {}) {
      const out = await call<{ data?: T; errors?: { message: string }[] }>(host, graphqlUrl(host), {
        body: JSON.stringify({ query, variables }),
        method: 'POST'
      })

      // Partial data with errors (one PR of a batch gone): the caller sees nulls where they failed.
      if (!out.data) {
        throw new GitHubError(out.errors?.map(e => e.message).join('; ') || 'GitHub sent no data')
      }

      return out.data
    },
    rest<T>(host: string, method: string, path: string, body?: unknown) {
      return call<T>(host, `${api(host)}${path}`, { body: body === undefined ? undefined : JSON.stringify(body), method })
    }
  }
}
