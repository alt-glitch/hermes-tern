// What the reducer and the views read and write of one turn: when it ended, its thoughts ending,
// the text that closes its last response, its share of the session's usage, and a call's args as
// the views show them.

import type { Usage } from '@hermes/shared/gateway-events'

import type { TurnEntry } from '../model.js'
import { withoutTernEnv } from '../view/describe.js'

/** When `turn` ended: undefined while it is live, and for a stored turn whose rows carry no time. */
export function turnEndedAt(turn: Pick<TurnEntry, 'end'>): number | undefined {
  return turn.end.status === 'live' ? undefined : turn.end.endedAt
}

/** Ends the thoughts of `turn` still streaming. */
export function endThinking(turn: TurnEntry, at: number) {
  for (const b of turn.blocks) {
    if (b.kind === 'thinking' && b.endedAt === undefined) {
      b.endedAt = at
    }
  }
}

/** The text after the last tool call: what message.complete's `text` repeats. */
export function trailingText(turn: TurnEntry): string {
  let out = ''

  for (const b of turn.blocks) {
    // A tool call or an interim seal (an empty text block) starts a new response.
    if (b.kind === 'tool' || (b.kind === 'text' && !b.text)) {
      out = ''
    } else if (b.kind === 'text') {
      out += b.text
    }
  }

  return out
}

/** One turn's share of the session totals: `now` minus `before`, field by field. */
export function usageSince(now: Usage, before: Usage | undefined): Usage {
  const less = (key: 'cost_usd' | 'input' | 'output' | 'total') => {
    const a = now[key]
    const b = before?.[key]

    return typeof a === 'number' ? Math.max(0, a - (typeof b === 'number' ? b : 0)) : undefined
  }

  return { ...now, cost_usd: less('cost_usd'), input: less('input'), output: less('output'), total: less('total') }
}

/** A call's args as views show them: a shell command as the agent wrote it, without the pane prefix the plugin's middleware adds (completion events carry the args that ran). */
export function shownArgs(args: Record<string, unknown>): Record<string, unknown> {
  const command = args['command']

  return typeof command === 'string' ? { ...args, command: withoutTernEnv(command) } : args
}
