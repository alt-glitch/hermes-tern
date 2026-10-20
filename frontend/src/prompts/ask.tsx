// What the question sheets share: their option list, the answer in flight and the line that says
// so, the ↑/↓ wrap and Ctrl+C. Each sheet is a modal bottom sheet in the shapes and roles omp's
// ask sheet uses (`omp.overlay.ask`, its options and action row), which Tern's chat styles size
// like the composer and read to show the pane as waiting for input.

import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import type { JSX, Key } from '@stencil-hq/tern'

import { optional } from '../core/assert.js'
import { errorText } from '../core/errors.js'
import type { Overlay, OverlayHost } from '../overlays/overlay.js'

/** One row of a sheet's option list. */
export interface Option {
  id: string
  label: string
  detail?: string
  recommended?: boolean
  checked?: boolean
  /** A radio (the default), a checkbox, or the Other row. */
  role?: 'omp.ask.check' | 'omp.ask.option' | 'omp.ask.other'
}

/** Ctrl+C on a question sheet declines it, as Esc does (the TUI's `cancelOverlayFromCtrlC`). */
export const isCtrlC = (k: Key) => k.ctrl && k.name === 'c'

/** The option list `listKey`, its items keyed under node `id`; a click selects, a double click or Enter picks. */
export function optionList(
  listKey: string,
  id: string,
  options: Option[],
  selected: number,
  select: (i: number) => void,
  pick: (i: number) => void
): JSX.Element {
  const at = (item: string) => options.findIndex(o => `${id}.${o.id}` === item)

  return (
    <list
      key={listKey}
      onActivate={ev => {
        const i = at(ev.item)

        if (i >= 0) {
          pick(i)
        }
      }}
      onSelect={ev => {
        const i = at(ev.item)

        if (i >= 0) {
          select(i)
        }
      }}
      role="omp.ask.options"
      {...optional('selected', options[selected] ? `${id}.${options[selected].id}` : undefined)}
    >
      {options.map(o => (
        <item
          key={o.id}
          {...optional('detail', o.detail ? [o.role === 'omp.ask.other' ? { s: 'dim', t: o.detail } : { t: o.detail }] : undefined)}
          {...optional('icon', o.checked ? 'check' : undefined)}
          label={[{ t: o.label }]}
          role={o.role ?? 'omp.ask.option'}
          {...optional('tone', o.checked ? 'success' : undefined)}
          {...optional('value', o.recommended ? [{ s: 'accent', t: 'Recommended' }] : undefined)}
        />
      ))}
    </list>
  )
}

/** An answer's progress on its sheet: in flight (a second answer waits), or refused with why. */
export interface Sending {
  busy: boolean
  error: string
}

/**
 * Answers `req`; the sheet closes once the answer lands. A shared prompt's `respond` returns its RPC
 * (hermes/sharedPrompts.ts), as Ink's card waits on approval.respond: a refusal keeps the sheet open
 * with the reason, to answer again. Another viewer's answer still closes it (`*.settled`).
 */
export function answerWith(
  host: OverlayHost,
  overlay: Overlay,
  req: ServerRequest,
  state: Sending,
  result: Record<string, unknown>
) {
  if (state.busy) {
    return
  }

  const sent: unknown = req.respond(result)

  if (!isThenable(sent)) {
    return host.close(overlay)
  }

  state.busy = true
  state.error = ''
  host.changed()
  sent.then(
    () => host.close(overlay),
    (error: unknown) => {
      state.busy = false
      state.error = errorText(error)
      host.changed()
    }
  )
}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  typeof v === 'object' && v !== null && 'then' in v && typeof v.then === 'function'

/** An answer no sheet waits on: a refusal has nowhere to show, and must not surface as an unhandled rejection. */
export function settleQuietly(sent: unknown) {
  if (isThenable(sent)) {
    sent.then(undefined, () => undefined)
  }
}

/** The line under a sheet's question while its answer is in flight or after a refusal. */
export function sendingLine(state: Sending): JSX.Element | null {
  if (state.error) {
    return (
      <text
        key="sending"
        spans={[{ s: 'error', t: `Not answered: ${state.error}. Answer again, or Esc to close without answering.` }]}
        wrap="word"
      />
    )
  }

  return state.busy ? <text key="sending" spans={[{ s: 'dim', t: 'Sending…' }]} /> : null
}

/** ↑/↓ (⌃P/⌃N) through `count` rows, wrapping; undefined when `key` isn't a move. */
export function moved(key: Key, at: number, count: number): number | undefined {
  if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
    return (at - 1 + count) % count
  }

  if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
    return (at + 1) % count
  }

  return undefined
}
