// Which hosts get a GitHub token, and where requests go: the host of a PR link comes from the model
// or a git remote, so only github.com and the enterprise hosts the user listed get a token.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { github, tokens } from '../github/client.js'

const SETTING = 'plugins.entries.hermes-tern.settings.enterprise_hosts'
const ENV = {
  GITHUB_ENTERPRISE_TOKEN: 'ghe-token',
  GITHUB_TOKEN: 'gh-token',
  HERMES_TERN_GITHUB_ENTERPRISE_HOSTS: 'ghe.corp.example,git.corp.example:8443'
}

/** Hosts a link could name that must get no token and no request. */
const UNTRUSTED = [
  'github.evil.com',
  'github.com.evil.com',
  'github.mycompany.com',
  'gist.github.com',
  'api.github.com',
  'evil.com/github.com',
  'user@github.com',
  'github.com:8443',
  'ghe.corp.example:8443',
  '140.82.112.3',
  '[::1]',
  'xn--gthub-n4a.com',
  ''
]

describe('tokens', () => {
  it("sends github.com's token to github.com only, and the enterprise token to a listed host only", async () => {
    const token = tokens(ENV)

    await expect(token('github.com')).resolves.toBe('gh-token')
    await expect(token('GitHub.COM.')).resolves.toBe('gh-token')
    await expect(token('ghe.corp.example')).resolves.toBe('ghe-token')
    await expect(token('git.corp.example:8443')).resolves.toBe('ghe-token')
  })

  it.each(UNTRUSTED)('gives %j no token, and says which setting would trust it', async host => {
    await expect(tokens(ENV)(host)).rejects.toThrow(SETTING)
  })

  it('trusts no enterprise host when the user listed none', async () => {
    await expect(tokens({ GITHUB_ENTERPRISE_TOKEN: 'ghe-token' })('ghe.corp.example')).rejects.toThrow(SETTING)
  })
})

describe('requests', () => {
  /** fetch, answering each call with the next of `answers` (then `{}`). */
  const fakeFetch = (...answers: Response[]) => {
    const fetch = vi.fn(async (_url: URL | string, _init?: RequestInit) => answers.shift() ?? Response.json({ data: {} }))
    vi.stubGlobal('fetch', fetch)

    return fetch
  }
  /** Each call's URL and Authorization header. */
  const sent = (fetch: ReturnType<typeof fakeFetch>) =>
    fetch.mock.calls.map(([url, init]) => [String(url), new Headers(init?.headers).get('authorization')])

  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) {
      vi.stubEnv(k, v)
    }

    vi.stubEnv('GH_TOKEN', '')
    vi.stubEnv('GH_ENTERPRISE_TOKEN', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('derives the API from the host: api.github.com for github.com, /api/v3 and /api/graphql on a listed host', async () => {
    const fetch = fakeFetch()
    const gh = github()

    await gh.graphql('github.com', 'query { viewer { login } }')
    await gh.graphql('GitHub.COM.', 'query { viewer { login } }')
    await gh.rest('ghe.corp.example', 'GET', '/repos/a/b/pulls/1/files')
    await gh.graphql('git.corp.example:8443', 'query { viewer { login } }')

    expect(sent(fetch)).toEqual([
      ['https://api.github.com/graphql', 'Bearer gh-token'],
      ['https://api.github.com/graphql', 'Bearer gh-token'],
      ['https://ghe.corp.example/api/v3/repos/a/b/pulls/1/files', 'Bearer ghe-token'],
      ['https://git.corp.example:8443/api/graphql', 'Bearer ghe-token']
    ])
  })

  it.each(UNTRUSTED)('sends nothing to %j', async host => {
    const fetch = fakeFetch()

    await expect(github().graphql(host, 'query { viewer { login } }')).rejects.toThrow(SETTING)
    await expect(github().rest(host, 'GET', '/repos/a/b/pulls/1/files')).rejects.toThrow(SETTING)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not let fetch follow a redirect with the token: it follows one itself, and only to the same origin', async () => {
    const fetch = fakeFetch(new Response(null, { headers: { location: 'https://evil.example/steal' }, status: 302 }))

    await expect(github().rest('github.com', 'GET', '/repos/a/b/pulls/1/files')).rejects.toThrow('evil.example')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe('manual')
  })

  it('refuses a redirect to plain http on the same host', async () => {
    const fetch = fakeFetch(new Response(null, { headers: { location: 'http://api.github.com/repos/a/b/pulls/1/files' }, status: 301 }))

    await expect(github().rest('github.com', 'GET', '/repos/a/b/pulls/1/files')).rejects.toThrow('redirected')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('follows a same-origin redirect (a renamed repository) with the token', async () => {
    const fetch = fakeFetch(
      new Response(null, { headers: { location: '/repositories/42/pulls/1/files' }, status: 301 }),
      Response.json([{ filename: 'a.ts' }])
    )

    await expect(github().rest('github.com', 'GET', '/repos/a/b/pulls/1/files')).resolves.toEqual([{ filename: 'a.ts' }])
    expect(sent(fetch)).toEqual([
      ['https://api.github.com/repos/a/b/pulls/1/files', 'Bearer gh-token'],
      ['https://api.github.com/repositories/42/pulls/1/files', 'Bearer gh-token']
    ])
  })

  it('gives up after a few redirects', async () => {
    const hop = () => new Response(null, { headers: { location: '/again' }, status: 307 })
    const fetch = fakeFetch(hop(), hop(), hop(), hop(), hop())

    await expect(github().rest('github.com', 'GET', '/x')).rejects.toThrow('redirect')
    expect(fetch).toHaveBeenCalledTimes(4)
  })
})
