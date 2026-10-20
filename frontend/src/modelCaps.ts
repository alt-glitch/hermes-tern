// What each model can do (reasoning, turning it off, fast mode), from `model.options`. session.info
// carries no capabilities, so the effort chip, the Shift+Tab cycle and the effort picker read them
// from here: filled whenever a picker loads the options, and once lazily by the effort picker.

import type { ModelCapabilities, ModelOptionProvider } from '@hermes/shared/gateway-events'
import type { GatewayClient } from '@tui/gatewayClient.js'

import { rpc } from './wire/rpc.js'

const known = new Map<string, ModelCapabilities>()

/** Keeps every listed model's capabilities, by provider and model. */
export function rememberCaps(providers: readonly ModelOptionProvider[]) {
  for (const p of providers) {
    for (const [model, caps] of Object.entries(p.capabilities ?? {})) {
      known.set(`${p.slug}\t${model}`, caps)
    }
  }
}

/** The session model's capabilities, if a load has seen them; by model alone when the provider is unknown. */
export function capsOf(info: { model?: string; provider?: string } | null | undefined): ModelCapabilities | undefined {
  const model = info?.model

  if (!model) {
    return undefined
  }

  const exact = info.provider ? known.get(`${info.provider}\t${model}`) : undefined

  if (exact) {
    return exact
  }

  const same = [...known].filter(([k]) => k.endsWith(`\t${model}`)).map(([, caps]) => caps)

  return same.length && same.every(c => JSON.stringify(c) === JSON.stringify(same[0])) ? same[0] : undefined
}

/** Loads the options for session `sid` and keeps their capabilities; never throws. */
export async function loadCaps(gw: Pick<GatewayClient, 'request'>, sid: string | null): Promise<void> {
  try {
    const r = await rpc(gw, 'model.options', sid ? { session_id: sid } : {})
    rememberCaps(r?.providers ?? [])
  } catch {
    // Unknown capabilities: every level stays on offer.
  }
}

/** Forgets every capability (tests). */
export function forgetCaps() {
  known.clear()
}
