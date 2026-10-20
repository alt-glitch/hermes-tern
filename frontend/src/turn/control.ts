// The running turn's controls over the shared gateway's dedicated RPCs: interrupt, steer and
// redirect, each fenced by the turn's execution generation. The busy path, the queue's Steer and
// the /steer and /stop commands all go through here.

import { errorText } from '../core/errors.js'
import { currentGeneration } from '../hermes/mutate.js'
import { type Requester, rpc } from '../wire/rpc.js'

/** Interrupts session `sid`'s active turn, fenced by its execution generation. */
export async function interruptTurn(gw: Requester, sid: string) {
  const execution_generation = await currentGeneration(gw, sid)

  await rpc(gw, 'session.interrupt', { session_id: sid, execution_generation })
}

/** Why a steer did not land; the text is for the user. */
export type SteerOutcome = { ok: true } | { ok: false; error?: string }

/** Injects `text` into session `sid`'s running turn. `ok` means the agent takes it after its current step. */
export async function steerTurn(gw: Requester, sid: string, text: string): Promise<SteerOutcome> {
  try {
    const execution_generation = await currentGeneration(gw, sid)
    const r = await rpc(gw, 'session.steer', { session_id: sid, execution_generation, text })

    return r?.status === 'queued' ? { ok: true } : { ok: false }
  } catch (e) {
    // A stale generation means the turn ended first; anything else is a real failure.
    return errorText(e).includes('stale_generation') ? { ok: false } : { error: errorText(e), ok: false }
  }
}

/**
 * Redirects session `sid`'s running turn with `text` (`display.busy_input_mode: interrupt`): the
 * agent drops its current model request and goes on with the correction as a user message; during
 * a tool it degrades to a steer. `ok` means the gateway took it.
 */
export async function redirectTurn(gw: Requester, sid: string, text: string): Promise<SteerOutcome> {
  try {
    const execution_generation = await currentGeneration(gw, sid)
    const r = await rpc(gw, 'session.redirect', { session_id: sid, execution_generation, text })

    return r?.status === 'redirected' || r?.status === 'queued' ? { ok: true } : { ok: false }
  } catch (e) {
    return errorText(e).includes('stale_generation') ? { ok: false } : { error: errorText(e), ok: false }
  }
}
