// Canonical profile setting for Vim: only Hermes config.get owns the value.
import type { ConfigGetResult } from '@hermes/shared/gateway-events'
import type { GatewayClient } from '@hermes/shared/gateway-client'

import type { Composer } from './composer.js'

/** A session owns the readback; concurrent reads and session switches cannot apply stale settings. */
export interface VimPreferenceHost {
  readonly gw: Pick<GatewayClient, 'request'>
  readonly composer: Pick<Composer, 'vim'>
  sid(): string | null
  changed(): void
}

/** Reads display.vim_mode (strict boolean true) with no second preference store. */
export class VimPreference {
  #read = 0
  #session: string | null = null

  constructor(private readonly host: VimPreferenceHost) {}

  async refresh() {
    const sid = this.host.sid()
    const read = ++this.#read
    if (this.#session !== sid) {
      this.#session = sid
      // Fail closed on a different session/profile until its own config arrives.
      this.host.composer.vim.setEnabled(false)
      this.host.changed()
    }
    if (!sid) return

    try {
      const result = await this.host.gw.request<ConfigGetResult>('config.get', { key: 'full', session_id: sid })
      if (this.host.sid() !== sid || this.#read !== read) return
      const config: unknown = result.config
      const display = config !== null && typeof config === 'object' && 'display' in config ? config.display : undefined
      const enabled = display !== null && typeof display === 'object' && 'vim_mode' in display && display.vim_mode === true
      this.host.composer.vim.setEnabled(enabled)
      this.host.changed()
    } catch {
      // An unavailable profile never enables Vim, and never discards the draft.
    }
  }
}
