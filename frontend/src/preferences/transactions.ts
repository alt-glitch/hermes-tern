// Serialize our own profile reads/writes and confirm every accepted setter by
// its owner's normalized config.get. This is optimistic detection, NOT an atomic
// cross-client CAS: the pinned Hermes config API exposes no expected_revision.
import type { GatewayClient } from '@hermes/shared/gateway-client'

import { rpc } from '../wire/rpc.js'

import { type Preference, preferenceValue, PROFILE_PREFERENCES, type ProfileRow } from './contracts.js'

const lanes = new WeakMap<GatewayClient, Promise<unknown>>()

function ordered<T>(gateway: GatewayClient, work: () => Promise<T>): Promise<T> {
  const previous = lanes.get(gateway) ?? Promise.resolve()
  const next = previous.then(work, work)
  lanes.set(gateway, next.catch(() => undefined))

  return next
}

export interface ProfileAccess {
  readonly gw: GatewayClient
  readonly sid: string
  /** Exact canonical SessionInfo.profile_name captured when the sheet opened. */
  readonly profile: string
  /** Checked before read, immediately before write and before showing a reply. */
  active(): boolean
}

function assertActive(access: ProfileAccess): void {
  // Direct dispatch falls back to the connection when a session is reaped.
  if (!access.sid.trim() || !access.profile.trim()) {
    throw new Error('Settings has no canonical owner profile. Reopen after session.info.')
  }

  if (!access.active()) {
    throw new Error('Settings session changed or sheet closed. Reopen Settings.')
  }
}

async function readValue(access: ProfileAccess, field: Preference): Promise<string> {
  assertActive(access)
  const result = await rpc(access.gw, 'config.get', { key: field.key, session_id: access.sid, profile: access.profile })
  assertActive(access)

  if (typeof result.value !== 'string') {
    throw new Error(`Hermes did not return a normalized value for ${field.key}.`)
  }

  // A newer Hermes version may introduce a word this pinned frontend does not
  // recognize. Show it but do not mutate it until Hermes exposes its schema.
  return result.value
}

/** Lazy, session-bound profile reads. Never request 'full', expanded secrets, or local settings.json. */
export function readProfile(access: ProfileAccess): Promise<ProfileRow[]> {
  return ordered(access.gw, async () => {
    const rows: ProfileRow[] = []

    for (const field of PROFILE_PREFERENCES) {
      rows.push({ field, value: await readValue(access, field) })
    }

    return rows
  })
}

export interface WriteReceipt {
  key: string
  value: string
}

/** Only normalized public words, after explicit UI admission. No false success on transport ACK. */
export function writeProfile(access: ProfileAccess, field: Preference, requested: unknown, expected: string): Promise<WriteReceipt> {
  const next = preferenceValue(field, requested)

  return ordered(access.gw, async () => {
    assertActive(access)
    const before = await readValue(access, field)

    if (before !== expected) {
      throw new Error('Profile changed outside this sheet. Reload before making a new change.')
    }

    if (before === next) {
      return { key: field.key, value: before }
    }

    assertActive(access)
    const result = await rpc(access.gw, 'config.set', {
      key: field.key,
      session_id: access.sid,
      profile: access.profile,
      value: next
    })
    assertActive(access)

    if (result.key !== field.key || result.confirm_required || result.value !== next) {
      throw new Error('The gateway did not confirm this setting. Reload its canonical value.')
    }

    const saved = await readValue(access, field)

    if (saved !== next) {
      throw new Error('Canonical readback differs from the requested value. Reload before retrying.')
    }

    return { key: field.key, value: saved }
  })
}
