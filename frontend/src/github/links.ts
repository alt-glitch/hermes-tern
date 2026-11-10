// The PRs the agent linked to this conversation (`link_pull_request`, the plugin's own tool). The
// plugin's Python half keeps them under the conversation's root (pull_requests.py) and answers the
// plugin RPC method below with them. A live turn's link calls carry the whole list in their
// results; a subagent's, which run in a session of their own, reach the pane as the session event
// `LINKS_CHANGED`, after which it reads the list again.

import type { ToolCall } from '../model.js'
import { record } from '../wire/json.js'
import type { Requester } from '../wire/rpc.js'

import type { PrRef } from './pullRequest.js'

export const LINK_TOOLS = new Set(['link_pull_request', 'list_pull_requests', 'unlink_pull_request'])

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

/** The list a link tool's result carries (`linked`), when the call succeeded. */
export function linkedFromResult(call: Pick<ToolCall, 'name' | 'outcome' | 'result'>): PrRef[] | undefined {
  if (!LINK_TOOLS.has(call.name) || call.outcome.kind !== 'done') {
    return undefined
  }

  const linked = record(call.result)?.['linked']

  return Array.isArray(linked) ? linked.map(refOf).filter((r): r is PrRef => Boolean(r)) : undefined
}

/** The links of session `sid`'s conversation, oldest first, as the plugin answers them. */
export async function linkedPullRequests(gw: Requester, sid: string): Promise<PrRef[]> {
  const linked = record(await gw.request<unknown>(LINKED_METHOD, { session_id: sid }))?.['linked']

  return Array.isArray(linked) ? linked.map(refOf).filter((r): r is PrRef => Boolean(r)) : []
}
