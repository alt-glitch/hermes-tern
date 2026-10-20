// Buttons in omp's `omp.btn` role, the action row an ask sheet ends with, and `pressable`: the
// native button every control a click works on sits in.

import { html, type JSX } from '@stencil-hq/tern'

import { optional } from '../../core/assert.js'

/** The class of `pressable`'s button: a native button with no look of its own (styles.ts). */
export const PRESS_CLASS = 'hermes-press'

/** A control the pointer, the keyboard and a screen reader can all press. */
export interface PressProps {
  key: string
  /** What a screen reader calls it: the words on it, without the keys that press it. */
  name: string
  /** What a click, Enter or Space does. */
  onClick?: (() => void) | undefined
  /** The action a click sends instead, for the input loop to answer (`connect-open=…`). */
  action?: string | undefined
  /** Actions the right-click menu offers, by the names the input loop answers. */
  menu?: readonly string[] | undefined
  /** The right-click menu's entries, by name. */
  onMenu?: Readonly<Record<string, () => void>> | undefined
  /**
   * The button's role, which `content` then goes without: for a control this plugin styles itself,
   * and for one of omp's that Tern's sheets style on any kind or hide (Send, Stop). An omp role
   * Tern styles on a row only (`.sf-row[data-role='omp.btn']`) stays on `content`.
   */
  role?: string | undefined
}

/**
 * `content` inside a native button named `name`, which takes the click. Tern focuses buttons and
 * fields only: a clickable row is a pointer target and nothing else, with no Tab stop, no Enter or
 * Space and no name a screen reader can read. `content` keeps omp's role and so its look: Tern's
 * sheets style omp's controls by kind and role (`.sf-row[data-role='omp.btn']`), and the button
 * adds no look of its own.
 */
export function pressable(p: PressProps, content: JSX.Element): JSX.Element {
  return (
    <html.button
      aria={p.name}
      class={PRESS_CLASS}
      key={p.key}
      {...optional('actions', p.action ? { click: p.action, ...optional('menu', p.menu) } : undefined)}
      {...optional('onClick', p.onClick)}
      {...optional('onMenu', p.onMenu)}
      {...optional('role', p.role)}
    >
      {content}
    </html.button>
  )
}

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
  return pressable(
    { key: b.key, name: b.label, onClick: b.onClick },
    <row
      align="center"
      gap="xs"
      key="face"
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
