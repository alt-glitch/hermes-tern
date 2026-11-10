// Namespaced plugin RPC capability handshake. An old/core-only Hermes must never
// impersonate a revision-bound plan authority just because it supports /plan.
import type { GatewayClient } from '@hermes/shared/gateway-client'

export const PLAN_METHODS = {
  status: 'hermes-tern.plan.status',
  mode: 'hermes-tern.plan.mode',
  edit: 'hermes-tern.plan.edit',
  annotate: 'hermes-tern.plan.annotate',
  decide: 'hermes-tern.plan.decide'
} as const

export type PlanMethod = keyof typeof PLAN_METHODS
export type PlanRpc = (method: PlanMethod, params: Record<string, unknown>) => Promise<unknown>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const PLAN_GATEWAY_REQUIRED = 'Needs Hermes plugin gateway methods for plan review.'

/** All five owned methods must be visible to this attached session, not a sessionless probe. */
export function supportsPlanMethods(reply: unknown): boolean {
  if (!isRecord(reply)) {
    return false
  }

  const methods = reply['plugin_methods']

  return Array.isArray(methods) &&
    Object.values(PLAN_METHODS).every(method => methods.includes(method))
}

/** No legacy plan.status alias: it could be a different authority or an old core. */
export async function planRpcForSession(gw: Pick<GatewayClient, 'request'>, sessionId: string): Promise<PlanRpc> {
  let capabilities: unknown

  try {
    capabilities = await gw.request<unknown>('gateway.capabilities', { session_id: sessionId })
  } catch {
    throw new Error(PLAN_GATEWAY_REQUIRED)
  }

  if (!supportsPlanMethods(capabilities)) {
    throw new Error(PLAN_GATEWAY_REQUIRED)
  }

  return (method, params) => gw.request<unknown>(PLAN_METHODS[method], params)
}

/** The fail-closed compatibility backend deliberately never claims an editable plan. */
export function planUnavailableReason(reply: unknown): string | undefined {
  if (isRecord(reply) && reply['supported'] === false) {
    const reason = reply['reason']

    return typeof reason === 'string' && reason.trim() ? reason : PLAN_GATEWAY_REQUIRED
  }

  return undefined
}
