// GitHub over HTTPS with the user's own token. The token comes through Hermes: `GITHUB_TOKEN` is a
// credential Hermes manages (`hermes config set GITHUB_TOKEN …` stores it in the profile's .env,
// which Hermes loads into the processes it starts, this frontend among them); `GH_TOKEN` from the
// environment works too. Another tool's login (the GitHub CLI's) is never read: the plugin catalog's
// rule 11. No token, no PR data: callers show why.
//
// A token goes only to a host hosts.ts trusts (github.com's to github.com, the enterprise one to a
// host the user listed), at an API URL derived from that host, over HTTPS. Redirects are followed
// here, and only back to the same origin: one to anywhere else fails rather than carry the token.

import * as z from 'zod/mini'

import { optional } from '../core/assert.js'
import { decodeJson } from '../wire/json.js'
import { loose } from '../wire/schemas.js'

import { type GitHubHosts, githubHosts, type TrustedHost, untrustedText } from './hosts.js'

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

/** `host` as hosts.ts trusts it; throws, before any token is read, for a host it does not. */
function trustedOr(hosts: GitHubHosts, host: string): TrustedHost {
  const trusted = hosts.trusted(host)

  if (!trusted) {
    throw new GitHubError(untrustedText(host))
  }

  return trusted
}

/** The token for `host`, from the environment Hermes gives this process: none for a host tern does not trust. */
export function tokens(env: NodeJS.ProcessEnv = process.env, hosts: GitHubHosts = githubHosts(env)): (host: string) => Promise<string> {
  return async host => {
    const { host: name, kind } = trustedOr(hosts, host)
    const own = kind === 'github' ? env['GITHUB_TOKEN'] || env['GH_TOKEN'] : env['GITHUB_ENTERPRISE_TOKEN'] || env['GH_ENTERPRISE_TOKEN']

    if (own) {
      return own
    }

    const variable = kind === 'github' ? 'GITHUB_TOKEN' : 'GITHUB_ENTERPRISE_TOKEN'

    throw new GitHubError(`No GitHub token for ${name}. Set one with \`hermes config set ${variable} <token>\`, then open a new pane.`)
  }
}

/** Redirects followed before a request gives up. */
const MAX_REDIRECTS = 3

/**
 * Fetches `url`, which must be at `origin`, following redirects itself: a same-origin hop (a
 * renamed repository) keeps the token, and a hop anywhere else fails before the token goes there.
 * fetch's own `follow` drops Authorization across origins in current Node, but older runtimes did not.
 */
async function send(url: URL, origin: string, init: RequestInit): Promise<Response> {
  let target = url

  for (let hop = 0; ; hop++) {
    if (target.origin !== origin) {
      throw new GitHubError(hop ? `GitHub redirected to ${target.host}; tern does not send your token there.` : untrustedText(target.host))
    }

    const res = await fetch(target, { ...init, redirect: 'manual', signal: AbortSignal.timeout(30_000) })
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null

    if (location === null && res.type !== 'opaqueredirect') {
      return res
    }

    await res.body?.cancel()

    if (location === null || hop >= MAX_REDIRECTS) {
      throw new GitHubError(`GitHub answered ${res.status}: a redirect tern does not follow`, res.status)
    }

    target = new URL(location, target)
  }
}

export function github(token = tokens(), hosts: GitHubHosts = githubHosts()): GitHub {
  /** Sends one request and decodes its answer with `answer`; throws GitHub's words for a failed one. */
  async function call<T>(answer: z.ZodMiniType<T>, host: string, url: (trusted: TrustedHost) => string, init: RequestInit): Promise<T> {
    const trusted = trustedOr(hosts, host)
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${await token(trusted.host)}`,
      'User-Agent': 'hermes-tern',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {})
    }
    const res = await send(new URL(url(trusted)), new URL(trusted.rest).origin, { ...init, headers })
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
      const out = await call(graphqlAnswer, host, t => t.graphql, {
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
      return call(z.unknown(), host, t => `${t.rest}${path}`, { ...optional('body', body === undefined ? undefined : JSON.stringify(body)), method })
    }
  }
}
