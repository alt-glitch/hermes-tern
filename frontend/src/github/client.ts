// GitHub over HTTPS with the user's own token. The token comes through Hermes: `GITHUB_TOKEN` is a
// credential Hermes manages (`hermes config set GITHUB_TOKEN …` stores it in the profile's .env,
// which Hermes loads into the processes it starts, this frontend among them); `GH_TOKEN` from the
// environment works too. Another tool's login (the GitHub CLI's) is never read: the plugin catalog's
// rule 11. No token, no PR data: callers show why.

import * as z from 'zod/mini'

import { optional } from '../core/assert.js'
import { decodeJson } from '../wire/json.js'
import { loose } from '../wire/schemas.js'

/** Why GitHub could not answer, in words for the sheet. */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

/**
 * GitHub's two APIs. Each answer is unread JSON: the caller decodes it with its own schema
 * (pullRequest.ts, branch.ts), as the shapes are the caller's to know.
 */
export interface GitHub {
  /** The query's `data`; throws GitHub's errors when it sent none. */
  graphql(host: string, query: string, variables?: Record<string, unknown>): Promise<unknown>
  rest(host: string, method: string, path: string, body?: unknown): Promise<unknown>
}

/** An error answer's body: GitHub's words, when it sent some. */
const failure = z.catch(z.object({ message: loose(z.string()) }), {})

/** A GraphQL answer: partial data comes with errors (one PR of a batch gone), and no data with only errors. */
const graphqlAnswer = z.catch(
  z.object({
    data: z.optional(z.unknown()),
    errors: loose(z.array(z.catch(z.object({ message: z.string() }), { message: '' })))
  }),
  { data: undefined }
)

const api = (host: string) => (host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`)
const graphqlUrl = (host: string) => (host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`)

/** The token for `host`, from the environment Hermes gives this process. */
export function tokens(env: NodeJS.ProcessEnv = process.env): (host: string) => Promise<string> {
  return async host => {
    const own =
      host === 'github.com' ? env['GITHUB_TOKEN'] || env['GH_TOKEN'] : env['GITHUB_ENTERPRISE_TOKEN'] || env['GH_ENTERPRISE_TOKEN']

    if (own) {
      return own
    }

    const name = host === 'github.com' ? 'GITHUB_TOKEN' : 'GITHUB_ENTERPRISE_TOKEN'

    throw new GitHubError(`No GitHub token for ${host}. Set one with \`hermes config set ${name} <token>\`, then open a new pane.`)
  }
}

export function github(token = tokens()): GitHub {
  /** Sends one request and decodes its answer with `answer`; throws GitHub's words for a failed one. */
  async function call<T>(answer: z.ZodMiniType<T>, host: string, url: string, init: RequestInit): Promise<T> {
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
    // A body that is not JSON throws its SyntaxError, as it always did.
    const json = text ? decodeJson(text) : undefined

    if (!res.ok) {
      const { message } = failure.parse(json)

      throw new GitHubError(message ? `GitHub: ${message}` : `GitHub answered ${res.status}`, res.status)
    }

    return answer.parse(json)
  }

  return {
    async graphql(host: string, query: string, variables: Record<string, unknown> = {}) {
      const out = await call(graphqlAnswer, host, graphqlUrl(host), {
        body: JSON.stringify({ query, variables }),
        method: 'POST'
      })

      // Partial data with errors (one PR of a batch gone): the caller sees nulls where they failed.
      if (!out.data) {
        throw new GitHubError(out.errors?.map(e => e.message).join('; ') || 'GitHub sent no data')
      }

      return out.data
    },
    rest(host: string, method: string, path: string, body?: unknown) {
      return call(z.unknown(), host, `${api(host)}${path}`, { ...optional('body', body === undefined ? undefined : JSON.stringify(body)), method })
    }
  }
}
