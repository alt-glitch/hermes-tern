// Buttons in omp's `omp.btn` role, and the action row an ask sheet ends with.

import type { JSX } from '@stencil-hq/tern'

/** One button. */
export interface ButtonProps {
  key: string
  label: string
  /** The keys that press it, drawn after the label. */
  keys?: string[]
  /** The keys as the tooltip names them, after the label (`Close  escape`); none, the tooltip is the label. */
  hint?: string
  /** `primary` in the accent, `danger` in the error tone. */
  kind?: 'danger' | 'primary'
  /** `none` keeps the label on one line. */
  wrap?: 'none'
  onClick(): void
}

/** A button: its label, then its keys. */
export function button(b: ButtonProps): JSX.Element {
  return (
    <row
      align="center"
      gap="xs"
      key={b.key}
      onClick={b.onClick}
      role="omp.btn"
      title={b.hint ? `${b.label}  ${b.hint}` : b.label}
      {...(b.kind ? { tone: b.kind === 'primary' ? 'accent' : 'error' } : {})}
    >
      <text key="label" text={b.label} {...(b.wrap ? { wrap: b.wrap } : {})} />
      {b.keys ? <kbd key="keys" keys={b.keys} /> : null}
    </row>
  )
}

/** omp's action row: the buttons at the end of the line. */
export function actionsRow(buttons: readonly ButtonProps[]): JSX.Element {
  return (
    <row align="center" gap="sm" key="actions" role="omp.actions">
      <spacer grow={1} key="fill" />
      {buttons.map(button)}
    </row>
  )
}
