// GitHub over HTTPS with the user's own token. The token comes through Hermes: `GITHUB_TOKEN` is a
// credential Hermes manages (`hermes config set GITHUB_TOKEN …` stores it in the profile's .env,
// which Hermes loads into the processes it starts, this frontend among them); `GH_TOKEN` from the
// environment works too. Another tool's login (the GitHub CLI's) is never read: the plugin catalog's
// rule 11. No token, no PR data: callers show why.

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

/** The token for `host`, from the environment Hermes gives this process. */
export function tokens(env: NodeJS.ProcessEnv = process.env): (host: string) => Promise<string> {
  return async host => {
    const own =
      host === 'github.com' ? env.GITHUB_TOKEN || env.GH_TOKEN : env.GITHUB_ENTERPRISE_TOKEN || env.GH_ENTERPRISE_TOKEN

    if (own) {
      return own
    }

    const name = host === 'github.com' ? 'GITHUB_TOKEN' : 'GITHUB_ENTERPRISE_TOKEN'

    throw new GitHubError(`No GitHub token for ${host}. Set one with \`hermes config set ${name} <token>\`, then open a new pane.`)
  }
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
