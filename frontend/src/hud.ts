// Keyboard focus on the pills above the composer (agents, shells), as Claude Code does it:
// Down on an empty prompt with no completion open focuses the first pill, Left/Right move
// between pills, Enter opens the focused one, Esc or Up hands the keys back to the composer.
// Any other key also hands them back and then reaches the composer, so typing just types.

import type { Key } from '@stencil-hq/tern'

export type Pill = 'agents' | 'shells'

/** What the composer looks like to the pill keys. */
export interface HudContext {
  /** The pills on show, left to right. */
  pills: readonly Pill[]
  /** The focused pill, if any. */
  focused?: Pill
  /** The prompt is empty, history is not being browsed and no completion list is open. */
  idle: boolean
}

/** A key's effect: the new focus, the pill to open, and whether the key ends here. */
export interface HudOutcome {
  focused?: Pill
  open?: Pill
  consumed: boolean
}

const plain = (k: Key) => !k.ctrl && !k.alt && !k.meta && !k.shift

export function hudKey(k: Key, cx: HudContext): HudOutcome {
  const { focused, pills } = cx

  if (!focused || !pills.includes(focused)) {
    return k.name === 'down' && plain(k) && cx.idle && pills.length
      ? { consumed: true, focused: pills[0] }
      : { consumed: false }
  }

  const at = pills.indexOf(focused)

  switch (plain(k) ? k.name : '') {
    case 'left':
      return { consumed: true, focused: pills[Math.max(0, at - 1)] }

    case 'right':
      return { consumed: true, focused: pills[Math.min(pills.length - 1, at + 1)] }

    case 'enter':

    case 'space':
      return { consumed: true, open: focused }

    case 'escape':

    case 'up':
      return { consumed: true }

    case 'down':
      return { consumed: true, focused }

    default:
      return { consumed: false }
  }
}
