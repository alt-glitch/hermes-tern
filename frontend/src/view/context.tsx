// OMP's native composer hairline, with a named native button rather than a second status pill.
// The meter/report entry pattern comes from Can Bölük / Stencil's ui-tsp and downstream Hermes ui-tsp.
import type { JSX } from '@stencil-hq/tern'

import { optional } from '../core/assert.js'
import { contextPercent, contextShare, CONTEXT_THRESHOLDS, type ContextWindow } from '../session/context.js'

import { compact } from './time.js'

export function contextMeter(context: ContextWindow | undefined, onOpen: () => void): JSX.Element {
  const percent = context ? `${contextPercent(context)}%` : undefined
  const label = percent ? `${percent} context` : 'Context unknown'

  return (
    <el
      aria={`Show context window: ${label}`}
      attrs={{ 'aria-haspopup': 'dialog' }}
      key="context"
      onClick={onOpen}
      role="omp.composer.context.action"
      tag="button"
      title={context ? `${context.used.toLocaleString()} of ${context.max.toLocaleString()} tokens · Show context window` : 'Context usage is not available · Show context window'}
    >
      <meter
        key="meter"
        label={percent ?? '?'}
        role="omp.composer.context"
        style="bar"
        thresholds={CONTEXT_THRESHOLDS}
        {...optional('total', context ? compact(context.max) : undefined)}
        {...optional('value', context ? contextShare(context) : undefined)}
      />
    </el>
  )
}
