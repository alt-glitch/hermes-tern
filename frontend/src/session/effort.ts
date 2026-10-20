// Reasoning effort, the session setting: the levels Hermes knows, the default, the levels a model
// takes, the Shift+Tab cycle, the chip's words, and setting it on the gateway. The picker
// (overlays/effort.tsx), the dock's chip and the /effort and /reasoning commands all read it.

import type { ModelCapabilities } from '@hermes/shared/gateway-events'

import type { ChatPorts } from '../app/ports.js'
import { errorText } from '../core/errors.js'
import { mutateSession } from '../hermes/mutate.js'
import { capsOf } from '../modelCaps.js'
import { rpc } from '../wire/rpc.js'

/** Hermes' levels (hermes_constants.VALID_REASONING_EFFORTS, with `none` for off), lowest first. */
export const LEVELS: { id: string; label: string; detail: string }[] = [
  { detail: 'No reasoning tokens', id: 'none', label: 'off' },
  { detail: 'The least thinking a model allows', id: 'minimal', label: 'minimal' },
  { detail: 'Quick answers', id: 'low', label: 'low' },
  { detail: 'The usual balance', id: 'medium', label: 'medium' },
  { detail: 'Harder problems', id: 'high', label: 'high' },
  { detail: 'More than high, where the model has it', id: 'xhigh', label: 'xhigh' },
  { detail: 'Everything the model can spend', id: 'max', label: 'max' },
  { detail: 'Past max where the route has it; elsewhere it sends max', id: 'ultra', label: 'ultra' }
]

/** The level a session runs at when none is set (hermes' DEFAULT_REASONING_EFFORT). */
export const DEFAULT_EFFORT = 'medium'

/** What Shift+Tab and the effort chip step through, lowest first (`none` turns reasoning off). */
const CYCLE = ['none', 'low', 'medium', 'high', 'xhigh']

/** The levels a model takes: none without reasoning, no `off` where it cannot be turned off; all when unknown. */
export function levelsFor(caps: ModelCapabilities | undefined): typeof LEVELS {
  if (caps?.reasoning === false) {
    return []
  }

  return caps?.can_disable_reasoning === false ? LEVELS.filter(l => l.id !== 'none') : LEVELS
}

/** The cycle's next level after `current` ('' is the default); from a level off the cycle, the next one up. */
export function nextEffort(current: string, caps?: ModelCapabilities): string | undefined {
  const offered = new Set(levelsFor(caps).map(l => l.id))
  const cycle = CYCLE.filter(id => offered.has(id))
  const rank = (id: string) => LEVELS.findIndex(l => l.id === id)
  const at = rank(current || DEFAULT_EFFORT)

  return cycle.find(id => rank(id) > at) ?? cycle[0]
}

/** The chip's words: `off`, `high`, a clamped `ultra→max` (what the route really sends). */
export function effortText(effort: string, wire?: string): string {
  const shown = effort === 'none' ? 'off' : effort || DEFAULT_EFFORT

  return wire && effort && wire !== effort && effort !== 'none' ? `${shown}→${wire}` : shown
}

/** What setting the effort reaches of the app. */
export type EffortSetter = Pick<ChatPorts, 'changed' | 'gw' | 'session' | 'transcript'>

/**
 * Sets the reasoning effort: `session` for this session only (the pill, ⇧⇥), `global` also as
 * config.yaml's `agent.reasoning_effort`, the default of every new session (Hermes' `/reasoning
 * <level> --global`). On the shared gateway the session level is its revision-fenced `reasoning`
 * mutation, as Ink and desktop send it: stored with the session, and session.info to every viewer.
 */
export async function applyEffort(host: EffortSetter, value: string, scope: 'global' | 'session') {
  const session = host.session
  const sid = session.ref.live

  if (!sid) {
    return
  }

  const before = session.info && { reasoning_effort: session.info.reasoning_effort, reasoning_effort_wire: session.info.reasoning_effort_wire }
  // Shown at once (and a quick second press steps from it); session.info confirms, with the wire level.
  session.info = session.info && { ...session.info, reasoning_effort: value, reasoning_effort_wire: undefined }
  host.changed()

  try {
    if (scope === 'session' && host.gw.isCanonical) {
      await mutateSession(host.gw, sid, 'reasoning', { effort: value })
    } else {
      await rpc(host.gw, 'config.set', { key: 'reasoning', scope, session_id: sid, value })
    }

    if (scope === 'global') {
      host.transcript.notice(`Reasoning effort ${value === 'none' ? 'off' : value} is now the default for new sessions.`)
    }
  } catch (error) {
    // Back to what the session runs, unless something newer has replaced the guess since.
    if (sid === session.ref.live && session.info && before && session.info.reasoning_effort === value) {
      session.info = { ...session.info, ...before }
    }

    host.transcript.notice(`Could not set the reasoning effort: ${errorText(error)}`, 'error')
  }

  host.changed()
}

/** Steps the session's reasoning effort up the levels its model takes (Shift+Tab, the chip); session.info echoes it back. */
export function cycleEffort(host: Pick<ChatPorts, 'changed' | 'session' | 'setEffort' | 'transcript'>) {
  const next = nextEffort(host.session.info?.reasoning_effort ?? '', capsOf(host.session.info))

  if (!next) {
    host.transcript.notice('This model has no reasoning effort to set.', 'warning')

    return host.changed()
  }

  void host.setEffort(next, 'session')
}
