// Live rows: a label in Tern's shimmer, and omp's working row (spinner, shining label, timer).

import type { Children, JSX } from '@stencil-hq/tern'

import { age } from '../time.js'

/** The shimmer's palette: a highlight sweeps from the dim text through the muted to the accent. */
export const SHIMMER = { high: 'accent', low: 'dim', mid: 'muted' } as const

/** A muted label in Tern's shimmer, the working line's: it reads as running. */
export function shimmerText(o: { key: string; role?: string; text: string }): JSX.Element {
  return <shimmer key={o.key} mode="classic" palette={SHIMMER} {...(o.role ? { role: o.role } : {})} spans={[{ s: 'muted', t: o.text }]} />
}

/** omp's working row. */
export interface WorkingRowProps {
  label: string
  /** The object the timer's age is fixed on (see time.ts `age`). */
  since: object
  startedAt: number
  now: number
  title?: string
  /** After the timer, at the row's end. */
  trailing?: Children
}

/** The working row: a spinner, the label shining, `·` and how long it has run. */
export function workingRow(w: WorkingRowProps): JSX.Element {
  return (
    <row align="center" gap="sm" key="working" role="omp.working" {...(w.title ? { title: w.title } : {})}>
      <spinner key="spinner" style="starburst" tone="accent" />
      {shimmerText({ key: 'label', role: 'omp.working.label', text: w.label })}
      <text key="sep" role="omp.working.sep" text="·" />
      <elapsed age={age(w.since, w.startedAt, w.now)} format="short" key="elapsed" />
      {w.trailing}
    </row>
  )
}
