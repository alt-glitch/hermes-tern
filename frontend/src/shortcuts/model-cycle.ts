// Relative model cycling uses the existing picker/switchModel confirmation contract.
// model.options inventories choices; pending routes are projected by session.info.

import type { ModelOptionsResult } from '@hermes/shared/gateway-events'

import type { ModelsHost } from '../overlays/models.js'
import { pickerValue, switchModel } from '../overlays/models.js'
import { confirmOverlay } from '../overlays/prompts.js'
import { rpc } from '../wire/rpc.js'

import { modelId, modelRecents, type RecentModel } from './model-recents.js'

/** Authenticated and available rows only, in the gateway's picker order. */
export function availableModels(options: Pick<ModelOptionsResult, 'providers'>): RecentModel[] {
  const rows = (options.providers ?? [])
    .filter(provider => provider.authenticated !== false)
    .flatMap(provider => (provider.models ?? [])
      .filter(model => !provider.unavailable_models?.includes(model))
      .map(model => ({ model, provider: provider.slug })))

  const seen = new Set<string>()

  return rows.filter(row => {
    const id = modelId(row)

    if (seen.has(id)) {
      return false
    }

    seen.add(id)

    return true
  })
}

/** session.info already projects the mid-turn pending pick at this Hermes pin. */
export function activeModel(options: ModelOptionsResult, sessionRoute: RecentModel): RecentModel {
  const currentProvider = options.providers.find(provider => provider.is_current)?.slug || options.provider || ''

  return {
    model: sessionRoute.model || options.model || '',
    provider: sessionRoute.provider || currentProvider
  }
}

/** Choose from recent selections, or from the full authorized picker inventory. */
export function cycleTarget(
  available: readonly RecentModel[],
  recent: readonly RecentModel[],
  active: RecentModel,
  direction: -1 | 1
): RecentModel | null {
  const allowed = new Set(available.map(modelId))
  const seen = new Set<string>()
  const valid = recent.filter(row => allowed.has(modelId(row))).filter(row => {
    const id = modelId(row)

    if (seen.has(id)) {
      return false
    }

    seen.add(id)

    return true
  })
  const rows = valid.length > 1 ? valid : available

  if (rows.length < 2) {
    return null
  }

  const at = rows.findIndex(row => modelId(row) === modelId(active))

  if (at < 0) {
    return direction === 1 ? rows[0] ?? null : rows[rows.length - 1] ?? null
  }

  return rows[(at + direction + rows.length) % rows.length] ?? null
}

export function cycleModel(host: ModelsHost, direction: -1 | 1): Promise<void> {
  // SessionView exposes the adopted ref, not the concrete SessionState ticket.
  // Each replacement adopts a new ref object, including A -> B -> A.
  const owner = host.session.ref
  const sid = owner.live
  const history = modelRecents(host.session)

  return history.enqueue(async () => {
    const current = () => host.session.ref === owner

    if (!sid || !current()) {
      return
    }

    try {
      const options = await rpc(host.gw, 'model.options', { session_id: sid })

      if (!current()) {
        return
      }

      const active = activeModel(options, {
        model: host.session.info?.model ?? '',
        provider: host.session.info?.provider ?? ''
      })
      const available = availableModels(options)
      const next = cycleTarget(available, history.list(sid), active, direction)

      if (!next) {
        host.transcript.notice('Only one model is available to cycle. Use /model to choose another.')
        host.changed()

        return
      }

      const value = pickerValue(next.model, next.provider)
      const result = await switchModel(host, value)

      if (!current()) {
        return
      }

      if (result.confirm_required) {
        host.open(confirmOverlay(host, {
          title: 'Switch to an expensive model?',
          detail: result.confirm_message || result.warning || next.model,
          confirm: 'Switch anyway',
          onConfirm: () => {
            if (!current()) {
              return
            }

            void switchModel(host, value, true).catch(error => {
              if (current()) {
                host.transcript.notice(error instanceof Error ? error.message : String(error), 'error')
                host.changed()
              }
            })
          }
        }))
      }
    } catch (error) {
      if (current()) {
        host.transcript.notice(error instanceof Error ? error.message : String(error), 'error')
        host.changed()
      }
    }
  })
}
