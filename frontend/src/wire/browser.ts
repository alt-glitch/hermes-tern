// Plugin-owned browser RPCs. The green Hermes gateway rejects a client-provided
// profile on plugin methods; the caller binds its *server-provided* profile
// identity and original SessionRef locally, then sends only session_id on wire.
// Older gateways must advertise the actual namespaced registration or refuse.
import type { GatewayClient } from '@hermes/shared/gateway-client'

import type { SessionView } from '../app/ports.js'
import { record } from './json.js'

export interface BrowserBlock {
  target_id: string
  title: string
  url: string
  owner?: number | null
  owned: boolean
  available: boolean
}

export interface BrowserBlocks {
  available: boolean
  blocks: BrowserBlock[]
  reason?: string
}

export interface BrowserTarget {
  target_id: string
  title: string
  url: string
  in_tern: true
  frame?: string
}

export type BrowserAction = 'hermes-tern.browser.adopt' | 'hermes-tern.browser.focus' | 'hermes-tern.browser.frame'
export type BrowserMethod = BrowserAction | 'hermes-tern.browser.blocks' | 'hermes-tern.browser.release'

type Requester = Pick<GatewayClient, 'request'>

export interface BrowserCaller {
  readonly sessionId: string
  readonly profile: string
  /** Proves this is still the same view of the same SessionRef. */
  readonly current: () => boolean
}

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const PREFIX = 'hermes-tern.browser.'
const ALL = ['blocks', 'adopt', 'focus', 'release', 'frame'].map(method => PREFIX + method)

/** Canonical identity comes from this attached session's server-supplied info,
 * never a guessed 'default' profile or a SID-only pin. */
export function browserCaller(session: SessionView): BrowserCaller | undefined {
  const ref = session.ref
  const id = ref.live
  const profile = session.info?.profile_name
  if (typeof id !== 'string' || !id || typeof profile !== 'string' || !PROFILE.test(profile)) {
    return undefined
  }
  return {
    sessionId: id,
    profile,
    current: () => session.ref === ref && session.ref.live === id && session.info?.profile_name === profile
  }
}

/** Tern native blocks have positive decimal identifiers; no aliases or selectors. */
export function validBrowserId(id: string): boolean {
  return /^[1-9][0-9]*$/.test(id)
}

/** Exact native child-frame path, not a JavaScript expression or a URL. */
export function validBrowserFrame(frame: string): boolean {
  return frame === 'main' || /^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))*$/.test(frame)
}

function requireCaller(caller: BrowserCaller): void {
  if (!caller || !caller.current() || !caller.sessionId || !PROFILE.test(caller.profile)) {
    throw new Error('Verified canonical Hermes profile and original session.ref required for browser control')
  }
}

/** Green KEY requester pattern: profile on config.get, NEVER on plugin RPC.
 * On the gateway only a real live session/transport can authorize a plugin RPC. */
async function ensureMethod(gw: Requester, caller: BrowserCaller, method: BrowserMethod): Promise<void> {
  requireCaller(caller)
  // KEY head b93ca91: config.get supports a canonical, profile-qualified
  // request. This cannot mint a session subscription or substitute for RPC auth.
  const profileReply: unknown = await gw.request('config.get', {
    key: 'profile',
    session_id: caller.sessionId,
    profile: caller.profile
  })
  requireCaller(caller)
  if (!record(profileReply)) {
    throw new Error('Hermes did not confirm a profile-qualified configuration read')
  }

  // This is the seam's public session-bound capability contract. A sessionless
  // capability probe and all older runtimes disclose no plugin browser methods.
  const capabilities: unknown = await gw.request('gateway.capabilities', { session_id: caller.sessionId })
  requireCaller(caller)
  const methods = record(capabilities)?.['plugin_methods']
  if (!Array.isArray(methods) || !methods.every(m => typeof m === 'string') ||
      !ALL.every(name => methods.includes(name)) || !methods.includes(method)) {
    throw new Error('Native browser requires Hermes plugin gateway methods and operator drive consent')
  }
}

function blockOf(input: unknown): BrowserBlock {
  const r = record(input)
  const id = r?.['target_id']
  const title = r?.['title']
  const url = r?.['url']
  const owned = r?.['owned']
  const available = r?.['available']
  const owner = r?.['owner']

  if (
    typeof id !== 'string' || !validBrowserId(id) ||
    typeof title !== 'string' || typeof url !== 'string' ||
    typeof owned !== 'boolean' || typeof available !== 'boolean' ||
    (owner !== undefined && owner !== null && (typeof owner !== 'number' || !Number.isSafeInteger(owner)))
  ) {
    throw new Error('Invalid native browser blocks reply from Hermes')
  }

  return {
    target_id: id, title, url, owned, available,
    ...(owner === null || typeof owner === 'number' ? { owner } : {})
  }
}

/** Read-only discovery cannot grant native drive. */
export async function listBrowserBlocks(gw: Requester, caller: BrowserCaller): Promise<BrowserBlocks> {
  await ensureMethod(gw, caller, 'hermes-tern.browser.blocks')
  const raw: unknown = await gw.request('hermes-tern.browser.blocks', { session_id: caller.sessionId })
  requireCaller(caller)
  const data = record(raw)

  if (!data || typeof data['available'] !== 'boolean' || !Array.isArray(data['blocks'])) {
    throw new Error('Invalid native browser blocks reply from Hermes')
  }

  const reason = data['reason']
  return {
    available: data['available'],
    blocks: data['blocks'].map(blockOf),
    ...(typeof reason === 'string' ? { reason } : {})
  }
}

/** The backend confirms the exact page; never infer from card, URL or title. */
export async function browserTarget(
  gw: Requester,
  action: BrowserAction,
  caller: BrowserCaller,
  targetId: string,
  frame?: string
): Promise<BrowserTarget> {
  if (!validBrowserId(targetId)) {
    throw new Error('Invalid Tern browser block id')
  }

  if (action === 'hermes-tern.browser.frame' && (!frame || !validBrowserFrame(frame))) {
    throw new Error('Use main or an exact frame index path (for example 0 or 1.0)')
  }

  await ensureMethod(gw, caller, action)
  const raw: unknown = await gw.request(action, {
    session_id: caller.sessionId,
    target_id: targetId,
    ...(action === 'hermes-tern.browser.frame' ? { frame } : {})
  })
  requireCaller(caller)
  const data = record(raw)
  const returned = data?.['target_id']
  const title = data?.['title']
  const url = data?.['url']
  const selectedFrame = data?.['frame']

  if (
    returned !== targetId || typeof title !== 'string' || typeof url !== 'string' ||
    data?.['in_tern'] !== true ||
    (selectedFrame !== undefined && selectedFrame !== null && typeof selectedFrame !== 'string')
  ) {
    throw new Error('Invalid native browser target confirmation from Hermes')
  }

  return {
    target_id: returned, title, url, in_tern: true,
    ...(typeof selectedFrame === 'string' ? { frame: selectedFrame } : {})
  }
}

/** No release success without an acknowledged native release/close. */
export async function releaseBrowserBlock(gw: Requester, caller: BrowserCaller, targetId: string): Promise<void> {
  if (!validBrowserId(targetId)) {
    throw new Error('Invalid Tern browser block id')
  }
  await ensureMethod(gw, caller, 'hermes-tern.browser.release')
  const raw: unknown = await gw.request('hermes-tern.browser.release', {
    session_id: caller.sessionId, target_id: targetId
  })
  requireCaller(caller)
  const result = record(raw)
  if (result?.['target_id'] !== targetId || result['released'] !== true) {
    throw new Error('Hermes did not confirm native browser block release')
  }
}
