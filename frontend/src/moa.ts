// Mixture-of-Agents events, after Ink's createGatewayEventHandler: the working row's label for each
// phase, and the label a reference model's answer carries as its own thought block.

/** The working row's label for a Mixture-of-Agents step, after Ink's `moa.progress` / `moa.phase` lines. */
export function moaLabel(type: string, payload: Record<string, unknown> | null | undefined): string | undefined {
  if (type === 'moa.progress' && typeof payload?.refs_done === 'number' && typeof payload.refs_total === 'number') {
    return `MoA: refs ${payload.refs_done}/${payload.refs_total}`
  }

  if (type === 'moa.aggregating' || (type === 'moa.phase' && payload?.phase === 'aggregator')) {
    return 'Aggregating…'
  }

  return undefined
}

/** A reference model's answer as its thought block's label: `Reference 2/3 · gpt-5`. */
export function moaReferenceLabel(label: string, index?: number | null, count?: number | null): string {
  return index && count ? `Reference ${index}/${count} · ${label}` : `Reference · ${label}`
}
