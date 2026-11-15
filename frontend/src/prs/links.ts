// The PRs the agent linked to this conversation (`link_pull_request`, the plugin's own tool) and the
// review guides it wrote for them (`write_review_guide`). The plugin's Python half keeps both under
// the conversation's root (pull_requests.py) and answers the plugin RPC method below with them. A
// live turn's link calls carry both in their results; a subagent's, which run in a session of their
// own, reach the pane as the session event `LINKS_CHANGED`, after which it reads them again.

import type { ToolCall } from '../model.js'
import { record } from '../wire/json.js'
import type { Requester } from '../wire/rpc.js'

/** A linked pull request, as pull_requests.py stores it. */
export interface PrRef {
  host: string
  /** `owner/repo`, lower case. */
  repository: string
  number: number
  url: string
}

/**
 * The conversation's review guides by `owner/repo#number` (lower case), as pull_requests.py stores
 * them. The pane passes them to the list file untouched: the `prs` plugin reads them.
 */
export type Guides = Readonly<Record<string, unknown>>

/** What a link tool's result and the plugin RPC carry: the links, oldest first, and the guides. */
export interface Linked {
  refs: PrRef[]
  guides: Guides
}

export const GUIDE_TOOL = 'write_review_guide'
export const LINK_TOOLS = new Set(['link_pull_request', 'list_pull_requests', 'unlink_pull_request', GUIDE_TOOL])

/** The plugin RPC method that answers a conversation's links, and the session event that says they changed (pull_requests.py). */
export const LINKED_METHOD = 'plugin.hermes-tern.pull_requests.linked'
export const LINKS_CHANGED = 'plugin.hermes-tern.pull_requests.changed'

function refOf(v: unknown): PrRef | undefined {
  const r = record(v)
  const host = typeof r?.['host'] === 'string' ? r['host'] : ''
  const repository = typeof r?.['repository'] === 'string' ? r['repository'] : ''
  const number = typeof r?.['number'] === 'number' ? r['number'] : 0

  return host && repository && number > 0
    ? { host, number, repository, url: typeof r?.['url'] === 'string' ? r['url'] : `https://${host}/${repository}/pull/${number}` }
    : undefined
}

function linkedOf(v: unknown): Linked | undefined {
  const r = record(v)
  const linked = r?.['linked']

  return Array.isArray(linked)
    ? { guides: record(r?.['guides']) ?? {}, refs: linked.map(refOf).filter((x): x is PrRef => Boolean(x)) }
    : undefined
}

/** The links and guides a link tool's result carries, when the call succeeded. */
export function linkedFromResult(call: Pick<ToolCall, 'name' | 'outcome' | 'result'>): Linked | undefined {
  return LINK_TOOLS.has(call.name) && call.outcome.kind === 'done' ? linkedOf(call.result) : undefined
}

/** The `owner/repo#number` a finished `write_review_guide` wrote. */
export function guideWritten(call: Pick<ToolCall, 'name' | 'outcome' | 'result'>): string | undefined {
  const written = call.name === GUIDE_TOOL && call.outcome.kind === 'done' ? record(call.result)?.['written'] : undefined

  return typeof written === 'string' ? written : undefined
}

/** `ref` as the list file keys it: `owner/repo#number`, lower case. */
export const guideKey = (ref: PrRef) => `${ref.repository.toLowerCase()}#${ref.number}`

/** The links and guides of session `sid`'s conversation, as the plugin answers them. */
export async function linkedPullRequests(gw: Requester, sid: string): Promise<Linked> {
  return linkedOf(await gw.request<unknown>(LINKED_METHOD, { session_id: sid })) ?? { guides: {}, refs: [] }
}
