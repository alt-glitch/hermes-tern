// Fast mode: the session's priority service tier, set with `config.set {key: 'fast'}` (gateway/
// session_tui_config.py `_set_fast`, which checks the session's route offers it). Neither gateway
// sends session.info after it, so the reply's word patches `info.fast` / `service_tier` here, as
// Ink's /fast does (ui-tui/src/app/slash/commands/session.ts).

import type { SessionLiveInfo } from '@hermes/shared/gateway-events'
import type { GatewayClient } from '@tui/gatewayClient.js'

import type { NoticeEntry } from './model.js'

export type FastWord = 'fast' | 'normal' | 'ultrafast'

/** What the fast commands reach of the app. */
export interface FastHost {
  readonly gw: Pick<GatewayClient, 'request'>
  readonly sid: string | null
  info: SessionLiveInfo | null
  readonly transcript: { notice(text: string, tone?: NoticeEntry['tone']): void }
  changed(): void
}

/** The stored tier each word sets (hermes' agent/fast_mode.py: `fast` is the `priority` tier). */
const TIERS: Record<FastWord, string> = { fast: 'priority', normal: '', ultrafast: 'ultrafast' }

/** The gateway's word for a tier, `normal` for anything else. */
export const fastWord = (value: unknown): FastWord => (value === 'fast' || value === 'ultrafast' ? value : 'normal')

/** The dock's bolt: the tier the session runs on, when it is a fast one. */
export function fastTier(info: SessionLiveInfo | null | undefined): 'fast' | 'ultrafast' | undefined {
  return info?.fast ? (info.service_tier === 'ultrafast' ? 'ultrafast' : 'fast') : undefined
}

/** `/fast <arg>`'s value for config.set, or null for a word it does not take. */
export function fastValue(arg: string): string | null {
  const word = arg.trim().toLowerCase()

  return ({ '': 'toggle', fast: 'fast', normal: 'normal', off: 'normal', on: 'fast', toggle: 'toggle', ultrafast: 'ultrafast' } as Record<string, string>)[word] ?? null
}

const describe = (word: FastWord) =>
  word === 'normal' ? 'Fast mode off.' : `${word === 'fast' ? 'Fast' : 'Ultrafast'} mode on: priority processing, billed higher.`

/** Sets the session's tier (`fast`, `ultrafast`, `normal` or `toggle`); true when it took. */
export async function setFast(host: FastHost, value: string): Promise<boolean> {
  const sid = host.sid

  if (!sid) {
    return false
  }

  try {
    const r = await host.gw.request<{ value?: string }>('config.set', { key: 'fast', session_id: sid, value })
    const word = fastWord(r?.value)

    if (sid === host.sid) {
      host.info = { ...host.info, fast: word !== 'normal', service_tier: TIERS[word] }
    }

    host.transcript.notice(describe(word))

    return true
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)

    host.transcript.notice(
      why.includes('fast_unavailable') ? 'This model has no fast mode on its current route.' : `Could not set fast mode: ${why}`,
      'warning'
    )

    return false
  } finally {
    host.changed()
  }
}

/** `/fast [on|off|fast|ultrafast|normal|toggle|status]`: no word toggles. */
export async function fastCommand(host: FastHost, arg: string) {
  if (arg.trim().toLowerCase() === 'status') {
    const r = await host.gw.request<{ value?: string }>('config.get', { key: 'fast', session_id: host.sid })

    return host.transcript.notice(`Fast mode: ${fastWord(r?.value)}.`)
  }

  const value = fastValue(arg)

  if (!value) {
    return host.transcript.notice('Usage: /fast [on|off|ultrafast|status]', 'warning')
  }

  await setFast(host, value)
}
