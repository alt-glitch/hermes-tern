// The gateway's events in. Each event type has one handler, in the feature file it belongs to
// (gateway/handlers/*), and each handler says what the event did to the pane: 'render' when what
// it shows changed, 'quiet' when nothing did (or the store it fed renders on its own). Another
// session's traffic is dropped first; an event type the contract does not declare (a newer
// gateway's) is told once and dropped. coverage.ts checks that every declared type is handled or
// named as ignored.

import type { AnyGatewayEvent, AnyGatewayEventName } from '@tui/gatewayTypes.js'

import { ownsEvent } from '../flow.js'

import { IGNORED } from './coverage.js'
import { agentHandlers, type AgentsCx } from './handlers/agents.js'
import { chromeHandlers, type ChromeCx } from './handlers/chrome.js'
import { processHandlers, type ProcessesCx } from './handlers/processes.js'
import { promptHandlers, type PromptsCx } from './handlers/prompts.js'
import { sessionHandlers, type SessionCx } from './handlers/session.js'
import { turnHandlers, type TurnCx } from './handlers/turn.js'

/** An event type the gateway contract declares. */
export type EventName = AnyGatewayEventName

/** The event of type `K`, its payload narrowed. */
export type EventOf<K extends EventName> = Extract<AnyGatewayEvent, { type: K }>

/** What an event did to the pane: 'render' asks for one render, 'quiet' asks for none. */
export type Outcome = 'quiet' | 'render'

/** Handlers by event type, each taking its own event and the context `Cx`. */
export type Handlers<Cx> = { [K in EventName]?: (ev: EventOf<K>, cx: Cx) => Outcome }

/** Everything the handlers reach of the app. */
export type EventCx = AgentsCx & ChromeCx & ProcessesCx & PromptsCx & SessionCx & TurnCx

/** Every handler, by event type; the feature tables name disjoint types (dispatch.test.ts checks). */
export const HANDLERS = {
  ...sessionHandlers,
  ...turnHandlers,
  ...agentHandlers,
  ...processHandlers,
  ...promptHandlers,
  ...chromeHandlers
} satisfies Handlers<EventCx>

/** The event types a handler takes. */
export type Handled = keyof typeof HANDLERS

const TABLE: Handlers<EventCx> = HANDLERS
const IGNORED_TYPES: ReadonlySet<string> = new Set(IGNORED)

/** Runs `ev`'s handler: the event's type picks the handler, and the event is the type it takes. */
function run<K extends EventName>(ev: EventOf<K> & { type: K }, cx: EventCx): Outcome | undefined {
  return TABLE[ev.type]?.(ev, cx)
}

/**
 * The dispatcher over `cx`: what each event did to the pane. `unknown` hears once of each event
 * type the contract does not declare.
 */
export function dispatcher(cx: EventCx, unknown: (type: string) => void = () => undefined): (ev: AnyGatewayEvent) => Outcome {
  const told = new Set<string>()

  return ev => {
    // Another session's traffic (one being closed, or left by a switch) never reaches this pane.
    if (!ownsEvent(cx.sid(), ev)) {
      return 'quiet'
    }

    // Own keys only: a type such as `constructor` names no handler.
    if (Object.hasOwn(TABLE, ev.type)) {
      return run(ev, cx) ?? 'quiet'
    }

    if (!IGNORED_TYPES.has(ev.type) && !told.has(ev.type)) {
      told.add(ev.type)
      unknown(ev.type)
    }

    return 'quiet'
  }
}
