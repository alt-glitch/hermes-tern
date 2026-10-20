// Number and trend formatting for job charts: `186 tok/s`, `5.37 ms`, `12.3k req`, `▲ 15%`.
// Ported from omp (packages/coding-agent/src/job-widgets/format.ts).

import type { Better, Trend } from './types.js'

const COMPACT_STEPS: readonly [number, string][] = [
  [1e12, 'T'],
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k']
]

/** Values from here up print compacted (`12.3k`); smaller ones print in full (`4096`). */
const COMPACT_FROM = 10_000

/** Units that scale to a larger one: bytes by 1000s, times up to hours. Steps are largest first. */
const SCALES: Record<string, readonly [number, string][]> = {
  B: [
    [1e12, 'TB'],
    [1e9, 'GB'],
    [1e6, 'MB'],
    [1e3, 'kB']
  ],
  ms: [
    [3_600_000, 'h'],
    [60_000, 'min'],
    [1000, 's']
  ],
  s: [
    [3600, 'h'],
    [60, 'min']
  ]
}

const ALIASES: Record<string, string> = { byte: 'B', bytes: 'B', msec: 'ms', sec: 's', secs: 's', second: 's', seconds: 's' }

/** The step `value` reads best in for `unit` (`1.8e9 B` → GB); none for a unit that does not scale or a value below its first step. */
export function unitStep(value: number, unit?: string): { step: number; unit: string } | undefined {
  const base = unit ? (ALIASES[unit.toLowerCase()] ?? unit) : ''
  const steps = SCALES[base]
  const hit = steps?.find(([step]) => Math.abs(value) >= step)

  return hit ? { step: hit[0], unit: hit[1] } : undefined
}

/**
 * A number with its unit: auto decimals (≥ 100 → 0, ≥ 10 → 1, else 2) unless `digits` is
 * given, whole numbers without decimals, large values compacted (`12.3k`, `4.5M`). `%`
 * attaches to the number; other units follow a space.
 */
export function formatNumber(value: number, unit?: string, digits?: number): string {
  if (!Number.isFinite(value)) {
    return '—'
  }

  // `959000 ms` reads as `16 min`, `1.8e9 B` as `1.8 GB`.
  const scaled = unitStep(value, unit)

  if (scaled) {
    const text = formatNumber(value / scaled.step, scaled.unit, digits ?? (Math.abs(value / scaled.step) >= 100 ? 0 : 1))

    // `16 min`, not `16.0 min`, unless the caller asked for the digits.
    return digits === undefined ? text.replace(/\.0(?= )/, '') : text
  }

  const magnitude = Math.abs(value)
  let text: string | undefined

  if (magnitude >= COMPACT_FROM) {
    for (const [step, suffix] of COMPACT_STEPS) {
      if (magnitude < step) {
        continue
      }

      const scaled = value / step
      text = `${scaled.toFixed(digits ?? (Math.abs(scaled) >= 100 ? 0 : 1))}${suffix}`

      break
    }
  }

  text ??=
    Number.isInteger(value) && digits === undefined ? String(value) : value.toFixed(digits ?? (magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2))

  if (!unit) {
    return text
  }

  return unit === '%' ? `${text}%` : `${text} ${unit}`
}

/**
 * How `last` moved from `first`, judged against `better`: `▲ 15%` / `▼ 3.2%`, or the absolute
 * move with its unit when `first` is 0. `success` toward `better`, `error` away from it;
 * undefined when nothing moved.
 */
export function formatTrend(first: number, last: number, better: Better, unit?: string): Trend | undefined {
  const delta = last - first

  if (delta === 0 || !Number.isFinite(delta)) {
    return undefined
  }

  const arrow = delta > 0 ? '▲' : '▼'
  const tone = delta > 0 === (better === 'higher') ? 'success' : 'error'

  if (first === 0) {
    return { text: `${arrow} ${formatNumber(Math.abs(delta), unit)}`, tone }
  }

  const percent = Math.abs(delta / first) * 100

  // Past 1000% a factor reads better: `▲ 182×`.
  if (percent >= 1000) {
    return { text: `${arrow} ${formatNumber(Math.abs(last / first))}×`, tone }
  }

  return { text: `${arrow} ${percent.toFixed(percent >= 10 ? 0 : 1)}%`, tone }
}

/** `value/total unit` in the total's unit: `1.2/1.8 GB`, `7/9 trials`. */
export function formatRatio(value: number, total: number, unit?: string): string {
  const scaled = unitStep(total, unit)

  if (scaled) {
    return `${formatNumber(value / scaled.step, undefined, 1)}/${formatNumber(total / scaled.step, scaled.unit, 1)}`
  }

  return `${formatNumber(value)}/${formatNumber(total, unit)}`
}
