// The pills above the composer (todos, agents, shells, PRs, goal, loop) and their keyboard focus,
// as Claude Code does it: Down on an empty prompt with no completion open focuses the first pill,
// Left/Right move between pills, Enter opens the focused one, Esc or Up hands the keys back to the
// composer. Any other key also hands them back and then reaches the composer, so typing just types.
// pills() and todos() say which pills show; Hud holds the focus and the todo panel's fold.

import type { Key } from '@stencil-hq/tern'

import type { Todo } from '../model.js'
import { todoProgress } from '../transcript/todos.js'

/** A pill above the composer. */
export type Pill = 'agents' | 'goal' | 'loop' | 'prs' | 'shells' | 'todos'

/** A pill that opens a sheet; the todo pill folds its list open in place. */
export type SheetPill = Exclude<Pill, 'todos'>

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
  /** The pill holding the keys after this one; none hands them back to the composer. */
  focused?: Pill | undefined
  open?: Pill
  consumed: boolean
}

const plain = (k: Key) => !k.ctrl && !k.alt && !k.meta && !k.shift

/** What key `k` does to the pills' focus. */
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

/** The agent's todo list while it matters: a turn runs, or something on it is still open. */
export function todos(list: Todo[] | undefined, busy: boolean): Todo[] | undefined {
  if (!list?.length) {
    return undefined
  }

  const { done, total } = todoProgress(list)

  return total && (busy || done < total) ? list : undefined
}

/** What the pills are drawn from. */
export interface PillSources {
  /** A turn runs. */
  busy: boolean
  /** The todo list that matters (todos()), if any. */
  todos: readonly Todo[] | undefined
  /** Subagents running. */
  agents: number
  /** Background processes running or recently exited. */
  shells: number
  /** PRs the conversation linked. */
  prs: number
  goal: boolean
  loop: boolean
}

/** The pills above the composer, left to right. */
export function pills(s: PillSources): Pill[] {
  return [
    // While a turn runs the todo pill rides the working line, where the keys don't reach it.
    ...(s.todos && !s.busy ? (['todos'] as const) : []),
    ...(s.agents ? (['agents'] as const) : []),
    ...(s.shells ? (['shells'] as const) : []),
    ...(s.prs ? (['prs'] as const) : []),
    ...(s.goal ? (['goal'] as const) : []),
    ...(s.loop ? (['loop'] as const) : [])
  ]
}

/** What the pills reach of the app. */
export interface HudHost {
  /** Opens the sheet behind `pill`. */
  open(pill: SheetPill): void
  /** Asks for a render. */
  changed(): void
}

/** The pill holding the keys, if any, and whether the todo panel above the composer is open. */
export class Hud {
  readonly #host: HudHost
  #focused: Pill | undefined
  #todosOpen = false

  constructor(host: HudHost) {
    this.#host = host
  }

  /** The pill holding the keys (Down from an empty prompt), if any. */
  get focused(): Pill | undefined {
    return this.#focused
  }

  /** The todo panel above the composer is open. */
  get todosOpen(): boolean {
    return this.#todosOpen
  }

  /** Down from an empty prompt focuses the pills; ←/→, Enter and Esc/↑ while one holds the keys. True when the key ends here. */
  key(k: Key, cx: Omit<HudContext, 'focused'>): boolean {
    const out = hudKey(k, { ...cx, ...(this.#focused ? { focused: this.#focused } : {}) })

    this.#focused = out.focused

    if (out.open) {
      this.#open(out.open)
    }

    return out.consumed
  }

  /** Folds the todo panel open or shut. */
  toggleTodos() {
    this.#todosOpen = !this.#todosOpen
    this.#host.changed()
  }

  /** Each frame: a pill that left (its last process aged out) hands the keys back. */
  prune(shown: readonly Pill[]) {
    this.#focused = this.#focused && shown.includes(this.#focused) ? this.#focused : undefined
  }

  /** The composer took the focus back (a click in it). */
  release() {
    this.#focused = undefined
  }

  #open(pill: Pill) {
    switch (pill) {
      case 'todos':
        this.toggleTodos()

        break

      case 'agents':

      case 'goal':

      case 'loop':

      case 'prs':

      case 'shells':
        this.#host.open(pill)

        break
    }
  }
}
