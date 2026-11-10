// The owning Hermes session's display settings are the only preference source.
// Adapted from Hermes ui-tsp/src/binding-preferences.ts; no local auth/config authority.

import type { ConfigGetResult } from '@hermes/shared/gateway-events'
import type { Key } from '@stencil-hq/tern'
import type { GatewayClient } from '@hermes/shared/gateway-client'

import type { SessionView } from '../app/ports.js'
import { rpc } from '../wire/rpc.js'

import { APP_SHORTCUTS, effectiveShortcuts, shortcutMatches, type Shortcut } from './actions.js'

/** Consume only supported full-config display fields after explicit profile scoping. */
function displayConfig(result: ConfigGetResult): Record<string, unknown> {
  const config = result.config

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config.get full did not return a config object')
  }

  const display = config['display']

  if (display === undefined || display === null) {
    return {}
  }

  if (typeof display !== 'object' || Array.isArray(display)) {
    throw new Error('display must be an object')
  }

  // Narrow the raw object to the only display keys this slice reads.
  return {
    tern_keybindings: 'tern_keybindings' in display ? display.tern_keybindings : undefined,
    tern_profile_identity: 'tern_profile_identity' in display ? display.tern_profile_identity : undefined
  }
}

function wantsProfile(result: ConfigGetResult): boolean {
  const config = result.config
  const display = config && typeof config === 'object' ? config['display'] : undefined

  return Boolean(display && typeof display === 'object' && !Array.isArray(display) && 'tern_profile_identity' in display && display.tern_profile_identity === true)
}

const reason = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Exact owner identity, captured before sending any preference read. */
export interface BindingOwner {
  readonly ref: SessionView['ref']
  readonly sid: string
  /** Canonical SessionInfo.profile_name; not a pretty label or HOME basename. */
  readonly profile: string
}

export interface BindingHost {
  readonly gw: Pick<GatewayClient, 'request'>
  readonly session: Pick<SessionView, 'ref' | 'info'>
  changed(): void
  notice(text: string): void
}

export class BindingPreferences {
  readonly #host: BindingHost
  #owner: BindingOwner | null = null
  #read = 0
  #actions: readonly Shortcut[] = APP_SHORTCUTS
  #profile = ''

  constructor(host: BindingHost) {
    this.#host = host
  }

  #same(a: BindingOwner | null, b: BindingOwner | null): boolean {
    return a === b || Boolean(a && b && a.ref === b.ref && a.sid === b.sid && a.profile === b.profile)
  }

  #active(owner: BindingOwner): boolean {
    const session = this.#host.session

    return Boolean(owner.sid && owner.profile.trim() && session.ref === owner.ref &&
      session.ref.live === owner.sid && session.info?.profile_name === owner.profile)
  }

  #reset(owner: BindingOwner | null): void {
    if (this.#same(this.#owner, owner) && this.#actions === APP_SHORTCUTS && !this.#profile) {
      return
    }

    this.#owner = owner
    this.#actions = APP_SHORTCUTS
    this.#profile = ''
    this.#host.changed()
  }

  get actions(): readonly Shortcut[] {
    return this.#owner && this.#active(this.#owner) ? this.#actions : APP_SHORTCUTS
  }

  /** Optional display identity, never used as gateway profile authority. */
  get profile(): string {
    return this.#owner && this.#active(this.#owner) ? this.#profile : ''
  }

  matches(id: string, key: Key): boolean {
    const item = this.actions.find(row => row.id === id)

    return item ? shortcutMatches(item, key) : false
  }

  /** A confirmed owner-scoped readback supersedes pending refresh work. */
  accept(result: ConfigGetResult, owner: BindingOwner, identity?: ConfigGetResult): boolean {
    if (!this.#active(owner)) {
      return false
    }

    try {
      const display = displayConfig(result)
      const configured = display['tern_keybindings']
      const actions = effectiveShortcuts(configured === undefined ? {} : configured)
      this.#owner = owner
      this.#actions = actions
      this.#profile = display['tern_profile_identity'] === true && typeof identity?.display === 'string'
        ? identity.display
        : ''
      this.#read++
      this.#host.changed()

      return true
    } catch (error) {
      // An invalid external edit preserves the last valid map only for this exact owner.
      if (!this.#same(this.#owner, owner)) {
        this.#reset(owner)
      }

      this.#read++
      this.#host.notice('Tern keybindings rejected: ' + reason(error) + '. Repair display.tern_keybindings in the owning profile config.')
      this.#host.changed()

      return false
    }
  }

  async refresh(): Promise<void> {
    const ref = this.#host.session.ref
    const read = ++this.#read

    // Object identity, not merely sid, invalidates an earlier owner immediately.
    if (this.#owner?.ref !== ref) {
      this.#reset(null)
    }

    // adoptSteps calls readShortcuts before it installs the snapshot's session.info.
    // Finish synchronous adoption before taking canonical profile authority.
    await Promise.resolve()

    if (this.#host.session.ref !== ref || this.#read !== read) {
      return
    }

    const sid = ref.live
    const profile = this.#host.session.info?.profile_name

    if (!sid || typeof profile !== 'string' || !profile.trim()) {
      // No unscoped fallback to the connection profile, even after session reap.
      this.#reset(null)
      return
    }

    const owner: BindingOwner = { ref, sid, profile }

    if (!this.#same(this.#owner, owner)) {
      this.#reset(owner)
    }

    const current = () => this.#read === read && this.#active(owner)

    try {
      const result = await rpc(this.#host.gw, 'config.get', { key: 'full', session_id: sid, profile })

      if (!current()) {
        return
      }

      let identity: ConfigGetResult | undefined

      if (wantsProfile(result)) {
        try {
          identity = await rpc(this.#host.gw, 'config.get', { key: 'profile', session_id: sid, profile })
        } catch (error) {
          if (!current()) {
            return
          }

          this.#host.notice('Tern profile identity unavailable: ' + reason(error) + '.')
        }
      }

      if (current()) {
        this.accept(result, owner, identity)
      }
    } catch (error) {
      if (!current()) {
        return
      }

      this.#host.notice('Tern preferences unavailable; using current valid shortcuts: ' + reason(error) + '.')
      this.#host.changed()
    }
  }
}
