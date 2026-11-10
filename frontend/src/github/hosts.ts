// Which hosts get a GitHub token. A PR link's host comes from the model (`link_pull_request`) or a
// git remote, so it is not trusted as given: the github.com token goes to github.com only, and the
// enterprise token only to a host the user listed in the plugin's `enterprise_hosts` setting. The
// launcher (__init__.py) hands that list over in HERMES_TERN_GITHUB_ENTERPRISE_HOSTS; the link tool
// (pull_requests.py) checks the same list when a link is made, and this checks it again before
// every request, so a link stored before the check came in gets no token either.

export const GITHUB = 'github.com'
/** The setting the user lists enterprise hosts in, as `hermes config set` takes it. */
export const HOSTS_SETTING = 'plugins.entries.hermes-tern.settings.enterprise_hosts'
const HOSTS_ENV = 'HERMES_TERN_GITHUB_ENTERPRISE_HOSTS'

/** One DNS label, ASCII only: an IDN host is compared in its punycode (xn--) form. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const PORT = /^[1-9][0-9]{0,4}$/
/** A last label a URL parser reads as an IPv4 number (WHATWG's "ends in a number"). */
const NUMERIC = /^(?:[0-9]+|0x[0-9a-f]*)$/

/**
 * `raw` as hosts are compared: lower case, one trailing dot dropped, `name` or `name:port`.
 * Undefined for anything else: userinfo, a path, an IP literal, a non-ASCII or empty label, a bad
 * port. pull_requests.py's normalize_host, the same rules.
 */
export function normalizeHost(raw: string): string | undefined {
  const host = raw.trim().toLowerCase()
  const colon = host.lastIndexOf(':')
  let name = colon < 0 ? host : host.slice(0, colon)
  const port = colon < 0 ? undefined : host.slice(colon + 1)

  if (port !== undefined && (!PORT.test(port) || Number(port) > 65535)) {
    return undefined
  }

  if (name.endsWith('.')) {
    name = name.slice(0, -1)
  }

  const labels = name.split('.')

  if (!name || name.length > 253 || !labels.every(l => LABEL.test(l)) || NUMERIC.test(labels.at(-1) ?? '')) {
    return undefined
  }

  return port === undefined ? name : `${name}:${port}`
}

/** A host tern talks to: its normalised name, which token it takes, and its API's base URLs. */
export interface TrustedHost {
  host: string
  kind: 'enterprise' | 'github'
  /** The REST API's root, derived from the host and never taken from a link. */
  rest: string
  graphql: string
}

export interface GitHubHosts {
  /** `host` if tern may send it a token, else undefined. */
  trusted(host: string): TrustedHost | undefined
}

/** The hosts the launcher says the user listed (comma separated), with github.com. */
export function githubHosts(env: NodeJS.ProcessEnv = process.env): GitHubHosts {
  const listed = new Set(
    (env[HOSTS_ENV] ?? '')
      .split(',')
      .map(normalizeHost)
      .filter((h): h is string => Boolean(h) && h !== GITHUB)
  )

  return {
    trusted(raw) {
      const host = normalizeHost(raw)

      if (host === GITHUB) {
        return { graphql: 'https://api.github.com/graphql', host, kind: 'github', rest: 'https://api.github.com' }
      }

      return host && listed.has(host) ? { graphql: `https://${host}/api/graphql`, host, kind: 'enterprise', rest: `https://${host}/api/v3` } : undefined
    }
  }
}

/** Why tern reads nothing from `host`, in words for the sheet. */
export const untrustedText = (host: string) =>
  `Not read: ${host} is not github.com or a GitHub Enterprise host you listed, so tern sends it no token. ` +
  `If you trust it, add it to ${HOSTS_SETTING} and open a new pane.`
