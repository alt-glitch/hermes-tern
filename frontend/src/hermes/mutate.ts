// Session controls on the shared gateway: one revision-fenced `session.mutate`
// (gateway/session_mutations.py). Ported from Hermes' ui-tui/src/app/slash/canonicalSessionControls.ts
// (mutateCanonical, modelPayload) without its Ink stores; the CAS tuple comes from a fresh
// `session.resume`, as there.
import { randomUUID } from 'node:crypto'

import type { GatewayClient } from '@tui/gatewayClient.js'

export type SessionOperation = 'model' | 'delete' | 'rename' | 'branch'

export interface MutationResult extends Record<string, unknown> {
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

interface Snapshot {
  revision?: number
  execution_generation?: number
}

/** Session `sid`'s current execution generation (the fence for steer/interrupt). */
export async function currentGeneration(gw: Pick<GatewayClient, 'request'>, sid: string): Promise<number> {
  const snapshot = await gw.request<Snapshot>('session.resume', { session_id: sid })

  if (!Number.isSafeInteger(snapshot?.execution_generation)) {
    throw new Error('The session did not report its execution generation; try again.')
  }

  return snapshot.execution_generation!
}

/** Mutates session `sid` at its current revision and generation; throws the owner's refusal. */
export async function mutateSession(
  gw: Pick<GatewayClient, 'request'>,
  sid: string,
  operation: SessionOperation,
  payload: Record<string, unknown>
): Promise<MutationResult> {
  const snapshot = await gw.request<Snapshot>('session.resume', { session_id: sid })

  if (!Number.isSafeInteger(snapshot?.revision) || !Number.isSafeInteger(snapshot?.execution_generation)) {
    throw new Error('The session did not report its revision; try again.')
  }

  const result = await gw.request<MutationResult | null>('session.mutate', {
    session_id: sid,
    request_id: randomUUID(),
    expected_revision: snapshot.revision,
    expected_generation: snapshot.execution_generation,
    operation,
    payload
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
