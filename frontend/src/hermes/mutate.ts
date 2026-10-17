// Session controls on the shared gateway: one revision-fenced `session.mutate`
// (gateway/session_mutations.py). Ported from Hermes' ui-tui/src/app/slash/canonicalSessionControls.ts
// (mutateCanonical, modelPayload) without its Ink stores; the CAS tuple comes from a fresh
// `session.resume`, as there.
import { randomUUID } from 'node:crypto'

import type { GatewayClient } from '@tui/gatewayClient.js'

export type SessionOperation = 'model' | 'delete' | 'rename' | 'rewind' | 'compress' | 'branch'

export interface MutationResult extends Record<string, unknown> {
  status?: string
  model?: string
  confirm?: string
  confirm_message?: string
  target_model?: string
  execution_generation?: number
}

/** The `session.resume` snapshot a mutation's CAS tuple is read from; a payload may name its target from it. */
export interface Snapshot {
  revision?: number
  execution_generation?: number
  messages?: Record<string, unknown>[]
  /** The stored rows (content + row_id) behind a display-projected `messages`. */
  stored_messages?: Record<string, unknown>[]
}

type Payload = Record<string, unknown>

/** Session `sid`'s current execution generation (the fence for steer/interrupt). */
export async function currentGeneration(gw: Pick<GatewayClient, 'request'>, sid: string): Promise<number> {
  const snapshot = await gw.request<Snapshot>('session.resume', { session_id: sid })

  if (!Number.isSafeInteger(snapshot?.execution_generation)) {
    throw new Error('The session did not report its execution generation; try again.')
  }

  return snapshot.execution_generation!
}

/**
 * Mutates session `sid` at its current revision and generation; throws the owner's refusal.
 * `payload` may be a function of the same snapshot (a rewind names its target row from it); its
 * null means "nothing to do" and resolves null without a write. A rename (metadata) carries no
 * generation fence, as mutateCanonical sends it.
 */
export async function mutateSession(
  gw: Pick<GatewayClient, 'request'>,
  sid: string,
  operation: SessionOperation,
  payload: Payload
): Promise<MutationResult>
export async function mutateSession(
  gw: Pick<GatewayClient, 'request'>,
  sid: string,
  operation: SessionOperation,
  payload: Payload | ((snapshot: Snapshot) => Payload | null)
): Promise<MutationResult | null>
export async function mutateSession(
  gw: Pick<GatewayClient, 'request'>,
  sid: string,
  operation: SessionOperation,
  payload: Payload | ((snapshot: Snapshot) => Payload | null)
): Promise<MutationResult | null> {
  const snapshot = await gw.request<Snapshot>('session.resume', { session_id: sid })

  if (!Number.isSafeInteger(snapshot?.revision) || !Number.isSafeInteger(snapshot?.execution_generation)) {
    throw new Error('The session did not report its revision; try again.')
  }

  const body = typeof payload === 'function' ? payload(snapshot) : payload

  if (!body) {
    return null
  }

  const result = await gw.request<MutationResult | null>('session.mutate', {
    session_id: sid,
    request_id: randomUUID(),
    expected_revision: snapshot.revision,
    ...(operation === 'rename' ? {} : { expected_generation: snapshot.execution_generation }),
    operation,
    payload: body
  })

  if (!result) {
    throw new Error('session.mutate returned nothing')
  }

  return result
}

/** `<model> [--provider <slug>] [--session]` as the model mutation's payload. */
export function modelPayload(arg: string): Record<string, string> {
  const parts = arg.trim().split(/\s+/)
  const model = parts.shift() ?? ''

  if (!model || model.startsWith('--')) {
    throw new Error('Usage: /model <name> [--provider <slug>]')
  }

  const payload: Record<string, string> = { model }

  while (parts.length) {
    const flag = parts.shift()!

    if (flag === '--session' || flag === '--tui-session') {
      continue
    }

    if (flag === '--provider' && parts[0] && !parts[0].startsWith('--')) {
      payload.provider = parts.shift()!

      continue
    }

    throw new Error(`/model: ${flag} is not supported here (the switch applies to this session)`)
  }

  return payload
}
