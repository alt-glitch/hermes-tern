// A typed slash name the way the Ink TUI resolves it (createSlashHandler.ts): an exact alias through
// the gateway's `commands.catalog` canon, else the best tier of prefix/substring matches, so `/hea`
// runs /heartbeat and `/s` says which commands it could mean. This frontend's own commands (/ps,
// /prs, /sidebar, …) are candidates too: the gateway's canon never lists them.

import type { CommandsCatalogResult } from '@hermes/shared/gateway-events'
import type { GatewayClient } from '@tui/gatewayClient.js'

import { HIDDEN_COMMANDS, localCommands } from './commands.js'
import { scoreSlashMenuItem } from './hermes/completion.js'
import { rpc } from './wire/rpc.js'

export type Resolution = { name: string } | { ambiguous: string[] } | null

/** Lowercase `/alias` → `/canonical` for the catalog's commands and this frontend's own, minus the hidden ones. */
function canonOf(catalog: Pick<CommandsCatalogResult, 'canon'> | undefined): Map<string, string> {
  const canon = new Map<string, string>()

  for (const [alias, target] of Object.entries(catalog?.canon ?? {})) {
    if (!HIDDEN_COMMANDS.has(target.replace(/^\//, '').toLowerCase())) {
      canon.set(alias.toLowerCase(), target)
    }
  }

  // A hidden command answers only its exact name or alias (a local command runs before any resolving).
  for (const c of localCommands().filter(c => !HIDDEN_COMMANDS.has(c.name))) {
    for (const n of [c.name, ...(c.aliases ?? [])]) {
      if (!canon.has(`/${n}`)) {
        canon.set(`/${n}`, `/${c.name}`)
      }
    }
  }

  return canon
}

/**
 * What typed command `name` (no slash) means: another name to run instead, several it could mean,
 * or null to send it as typed (it is canonical already, a skill, or matches nothing known).
 */
export function resolveSlashName(
  name: string,
  catalog: Pick<CommandsCatalogResult, 'canon' | 'skills'> | undefined
): Resolution {
  const needle = `/${name.toLowerCase()}`

  if (!name || Object.keys(catalog?.skills ?? {}).some(k => k.toLowerCase() === needle)) {
    // A skill's own name is never widened into a command it prefixes.
    return null
  }

  const canon = canonOf(catalog)
  const exact = canon.get(needle)

  if (exact) {
    return exact.toLowerCase() === needle ? null : { name: exact.slice(1) }
  }

  // Name tiers only (exact 0, prefix 1, substring 2); the best one wins, so a substring never makes a prefix ambiguous.
  const scored = [...canon]
    .map(([alias, target]) => ({ score: scoreSlashMenuItem({ id: alias.slice(1) }, name.toLowerCase()), target }))
    .filter(s => s.score < 3)
  const best = Math.min(...scored.map(s => s.score))
  const matches = [...new Set(scored.filter(s => s.score === best).map(s => s.target))]

  const [only] = matches

  if (only !== undefined && matches.length === 1 && only.toLowerCase() !== needle) {
    return { name: only.slice(1) }
  }

  return matches.length > 1 ? { ambiguous: matches } : null
}

/** The notice for a name that could mean several commands (Ink's `ambiguous command: …`). */
export function ambiguousNotice(name: string, matches: readonly string[]): string {
  return `/${name} could mean ${matches.slice(0, 6).join(', ')}${matches.length > 6 ? ', …' : ''}. Type more of the name.`
}

/**
 * `commands.catalog` for the shown session, loaded once per session (project-local skills follow
 * its folder) and again after `reset` (/reload-skills). A failed load resolves to undefined and
 * is retried on the next ask.
 */
export class CommandCatalog {
  #sid: string | undefined
  #pending: Promise<CommandsCatalogResult | undefined> | undefined
  readonly #gw: Pick<GatewayClient, 'request'>

  constructor(gw: Pick<GatewayClient, 'request'>) {
    this.#gw = gw
  }

  get(sid: string): Promise<CommandsCatalogResult | undefined> {
    if (!this.#pending || this.#sid !== sid) {
      this.#sid = sid
      const pending = rpc(this.#gw, 'commands.catalog', { session_id: sid }).catch(() => {
        if (this.#pending === pending) {
          this.#pending = undefined
        }

        return undefined
      })

      this.#pending = pending
    }

    return this.#pending
  }

  reset() {
    this.#pending = undefined
  }
}
