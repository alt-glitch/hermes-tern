// Context-window counts are not the session's cumulative billing tokens.
import type { Usage } from '@hermes/shared/gateway-events'

export interface ContextWindow {
  readonly used: number
  readonly max: number
}

/** Visual warning colors, not the backend's automatic compaction threshold. */
export const CONTEXT_THRESHOLDS = { bad: 0.85, warn: 0.6 }

export function contextCount(n: number | null | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
}

/** A missing used count stays unknown, even when the model's capacity is known. */
export function contextWindow(usage: Pick<Usage, 'context_used' | 'context_max'> | null): ContextWindow | undefined {
  const used = contextCount(usage?.context_used)
  const max = contextCount(usage?.context_max)

  return used !== undefined && max !== undefined && max > 0 ? { max, used } : undefined
}

export function contextPercent(context: ContextWindow): number {
  return Math.round((context.used / context.max) * 100)
}

/** The painted bar is bounded, but the label and token counts retain an over-capacity reading. */
export function contextShare(context: ContextWindow): number {
  return Math.min(1, context.used / context.max)
}
