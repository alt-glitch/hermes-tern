// Mixture-of-Agents events, after Ink's createGatewayEventHandler: the working row's label for each
// phase, and the label a reference model's answer carries as its own thought block.

import type { AnyGatewayEvent } from '@tui/gatewayTypes.js'

/** The events that set the working row's label during a Mixture-of-Agents turn. */
export type MoaStepEvent = Extract<AnyGatewayEvent, { type: 'moa.aggregating' | 'moa.phase' | 'moa.progress' }>

/** The working row's label for a Mixture-of-Agents step, after Ink's `moa.progress` / `moa.phase` lines. */
export function moaLabel(ev: MoaStepEvent): string | undefined {
  switch (ev.type) {
    case 'moa.progress':
      return typeof ev.payload?.refs_done === 'number' && typeof ev.payload.refs_total === 'number'
        ? `MoA: refs ${ev.payload.refs_done}/${ev.payload.refs_total}`
        : undefined

    case 'moa.phase':
      return ev.payload?.phase === 'aggregator' ? 'Aggregating…' : undefined

    case 'moa.aggregating':
      return 'Aggregating…'
  }
}

/** A reference model's answer as its thought block's label: `Reference 2/3 · gpt-5`. */
export function moaReferenceLabel(label: string, index?: number | null, count?: number | null): string {
  return index && count ? `Reference ${index}/${count} · ${label}` : `Reference · ${label}`
}
