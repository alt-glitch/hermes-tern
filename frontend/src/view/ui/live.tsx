// Live rows: a label in Tern's shimmer, and omp's working row (spinner, shining label, timer).

import type { Children, JSX } from '@stencil-hq/tern'

import { plural } from '../../core/text.js'

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
  /** The step the label names, when it started after the turn: its age first, the turn's after it, dim. */
  step?: { since: object; startedAt: number }
  /** After the timer, at the row's end. */
  trailing?: Children
}

/**
 * The working row: a spinner, the label shining, `·` and how long it has run. A label set during
 * the turn (a step) shows its own age, then the turn's in dim (`· turn 17m 06s`), so a step that
 * just began never reads as stuck for the whole turn.
 */
export function workingRow(w: WorkingRowProps): JSX.Element {
  const turn = <elapsed age={age(w.since, w.startedAt, w.now)} format="short" key="elapsed" />

  return (
    <row align="center" gap="sm" key="working" role="omp.working" {...(w.title ? { title: w.title } : {})}>
      <spinner key="spinner" style="starburst" tone="accent" />
      {shimmerText({ key: 'label', role: 'omp.working.label', text: w.label })}
      <text key="sep" role="omp.working.sep" text="·" />
      {w.step ? <elapsed age={age(w.step.since, w.step.startedAt, w.now)} format="short" key="step" /> : turn}
      {w.step ? (
        <row align="center" gap="xs" key="turn" role="omp.working.turn" title="This turn has run this long">
          <text key="sep" role="omp.working.sep" text="·" />
          <text key="t" spans={[{ s: 'dim', t: 'turn' }]} />
          {turn}
        </row>
      ) : null}
      {w.trailing}
    </row>
  )
}

/** The idle session's line while its background agents run: how many, since the oldest started; a click opens them. */
export function waitingAgentsRow(a: { count: number; since: object; startedAt: number; now: number; onOpen: () => void }): JSX.Element {
  return (
    <row align="center" gap="sm" key="agents" onClick={a.onOpen} role="hermes.waiting.agents" title="Hermes goes on by itself when they finish · click to see them  ⌥A">
      <spinner key="spinner" style="dots" tone="muted" />
      <text key="label" spans={[{ s: 'muted', t: `Waiting for ${plural(a.count, 'background agent')}` }]} wrap="none" />
      <text key="sep" role="omp.working.sep" text="·" />
      <elapsed age={age(a.since, a.startedAt, a.now)} format="short" key="elapsed" />
    </row>
  )
}
