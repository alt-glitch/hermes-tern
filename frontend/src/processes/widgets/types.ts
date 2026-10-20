// A background process's live chart as the views draw it: the shells pill's glance and its
// hover card, the Background sheet and the background terminal card. Plain data, computed
// from the process's output by the spec's rules (runtime.ts). Ported from omp's
// `JobWidgetView` (packages/tui/src/tools/job-widget.ts).

import type { Tone } from '@stencil-hq/tern'

export type Better = 'higher' | 'lower'

/** A formatted move with its direction: `▲ 15%`, toned toward or away from `better`. */
export interface Trend {
  text: string
  tone: 'success' | 'error' | 'muted'
}

/** The one number a glance should take away (`186 tok/s`). */
export interface Headline {
  text: string
  /** What the value is, when the title does not already say it (`decode`, `p50`). */
  label?: string
  trend?: Trend
}

/** A time series drawn as columns, newest right, with optional reference lines. */
export interface SparkBlock {
  kind: 'spark'
  label: string
  /** At most 48 values, oldest first, already downsampled. */
  values: number[]
  /** The chart's domain; covers the values and every mark. */
  min: number
  max: number
  /** Dashed reference lines in value units (a target). */
  marks?: { value: number; label: string; tone?: Tone }[]
  /** The latest value, formatted. */
  last: string
  /** Per-point tooltips (`12:04:31 · 186 tok/s`). */
  tips?: string[]
  tone?: Tone
}

/** One bar per key (a model, a shard) against a common maximum. */
export interface BarsBlock {
  kind: 'bars'
  label: string
  items: { label: string; value: number; text: string; tone?: Tone }[]
  max: number
}

/** Progress of a countable whole (`7/9 trials`). */
export interface MeterBlock {
  kind: 'meter'
  label: string
  /** 0–1. */
  value: number
  text: string
  tone?: Tone
}

/** A few labelled numbers on one line (`p50 41 ms · errors 0`). */
export interface StatBlock {
  kind: 'stat'
  items: { label: string; text: string; tone?: Tone; trend?: Trend }[]
}

/** One cell per key with its latest state (CI jobs, shards). */
export interface GridBlock {
  kind: 'grid'
  label: string
  items: { label: string; text: string; tone: Tone }[]
}

/** The latest text a rule captured (the test now running). */
export interface TextBlock {
  kind: 'text'
  text: string
}

export type Block = SparkBlock | BarsBlock | MeterBlock | StatBlock | GridBlock | TextBlock

/**
 * Where a chart stands: `authoring` while the model writes its spec, `live` once the spec's
 * rules drive it, `fallback` without a spec (line counts and the last line only).
 */
export type ChartState = 'authoring' | 'live' | 'fallback'

export interface ChartView {
  /** What is watched (`load test · rps`). */
  title: string
  headline?: Headline
  /** What the process does now: a captured step, else its newest output line. */
  stage?: string
  /** Top to bottom; the first is the primary block that compact views show. */
  blocks: Block[]
  state: ChartState
  /** Epoch ms of the newest data the view reflects. */
  updatedAt: number
}
