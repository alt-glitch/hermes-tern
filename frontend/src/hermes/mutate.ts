// Session controls on the shared gateway: one revision-fenced `session.mutate`
// (gateway/session_mutations.py). Ported from Hermes' ui-tui/src/app/slash/canonicalSessionControls.ts
// (mutateCanonical, modelPayload) without its Ink stores; the CAS tuple comes from a fresh
// `session.resume`, as there.
import { randomUUID } from 'node:crypto'

import type { SessionMutateResult } from '@hermes/shared/gateway-events'
import type { GatewayClient } from '@tui/gatewayClient.js'

import { type AdaptedSnapshot, rpc } from '../wire/rpc.js'

export type SessionOperation = 'model' | 'reasoning' | 'delete' | 'rename' | 'rewind' | 'compress' | 'branch'

/**
 * What `session.mutate` answers: the contract's fields, and those of the operations this frontend
 * sends, which the contract leaves open (a model switch's `confirm`, a branch's child, a rename's title).
 */
export type MutationResult = SessionMutateResult & {
  status?: string
  model?: string
  confirm?: string
  confirm_message?: string
  target_model?: string
  execution_generation?: number
  /** A `branch`'s child session. */
  branched_session_id?: string
  /** A `rename`'s stored title. */
  title?: string
}

type Payload = Record<string, unknown>

/** Number.isSafeInteger as a guard. */
const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value)

/** Session `sid`'s current execution generation (the fence for steer/interrupt). */
export async function currentGeneration(gw: Pick<GatewayClient, 'request'>, sid: string): Promise<number> {
  const snapshot = await rpc(gw, 'session.resume', { session_id: sid })
  // Only the shared gateway's snapshot carries one; a private gateway's has no fence.
  const generation = snapshot && 'execution_generation' in snapshot ? snapshot.execution_generation : undefined

  if (!isSafeInteger(generation)) {
    throw new Error('The session did not report its execution generation; try again.')
  }

  return generation
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
  payload: Payload | ((snapshot: AdaptedSnapshot) => Payload | null)
): Promise<MutationResult | null>
export async function mutateSession(
  gw: Pick<GatewayClient, 'request'>,
  sid: string,
  operation: SessionOperation,
  payload: Payload | ((snapshot: AdaptedSnapshot) => Payload | null)
): Promise<MutationResult | null> {
  const snapshot = await rpc(gw, 'session.resume', { session_id: sid })

  if (!snapshot || !('revision' in snapshot) || !isSafeInteger(snapshot.revision) || !isSafeInteger(snapshot.execution_generation)) {
    throw new Error('The session did not report its revision; try again.')
  }

  const body = typeof payload === 'function' ? payload(snapshot) : payload

  if (!body) {
    return null
  }

  const result = await rpc(gw, 'session.mutate', {
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
      payload['provider'] = parts.shift()!

      continue
    }

    // The shared gateway switches a session only: no RPC here writes the profile's default model.
    throw new Error(
      flag === '--global'
        ? '/model: --global is not supported here: the switch applies to this session only (`hermes model` sets the default)'
        : `/model: ${flag} is not supported here (the switch applies to this session)`
    )
  }

  return payload
}
