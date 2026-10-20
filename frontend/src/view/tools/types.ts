// The shapes the tool views share: the card every card family returns and the shell
// (shell.tsx) turns into a `tool` node, and the view each tool has in the registry
// (registry.ts): its card, its step line and what it counts as in a work group.

import type { JSX, Tone } from '@stencil-hq/tern'

import type { ToolCall } from '../../model.js'
import type { DetailOf, ToolKey } from '../../tools/detail.js'

/** How one call presents: omp's tool props (minus status and timing) and its body. */
export interface Card {
  name: string
  title: string
  target?: string | undefined
  targetKind?: 'command' | 'path' | 'pattern' | 'query' | 'text' | undefined
  role?: string | undefined
  /** The language of a command head; Tern's ToolProps has no `lang` yet, so the shell passes it through. */
  lang?: string | undefined
  meta?: string[] | undefined
  badges?: { text: string; tone?: Tone }[] | undefined
  /** `inline` drops the frame and keeps the head line (omp's read, grep, glob). */
  frame?: 'inline' | undefined
  /** With an inline frame: framed again once settled with a body (web_search's sources). */
  framedWithBody?: true | undefined
  /** Folded once settled. */
  folded?: boolean | undefined
  preview?: { lines: number } | { tail: number } | undefined
  /** Overrides the derived status (a task stays running while its agents work). */
  status?: 'running' | undefined
  /** Overrides the call's own duration (a background task lasts until its agents finish). */
  took?: number | undefined
  body: JSX.Element[]
}

/** What a call counts as in a work group's summary, after t3code's `toolGroupAction`; its icon follows. */
export type Action =
  | 'app'
  | 'browser'
  | 'code-search'
  | 'command'
  | 'edit'
  | 'fetch'
  | 'lookup'
  | 'other'
  | 'plan'
  | 'read'
  | 'search'

/**
 * Tool `K`'s view, the one place that knows how its calls present: the card, the step line of a
 * work group, the action it counts as, and its icon in the agents hub. The hooks let the shell
 * ask a tool what only it knows, in place of testing the tool's name.
 */
export interface ToolView<K extends ToolKey> {
  action: Action
  /** Its icon in the agents hub's timeline, which knows only the name; a wrench when unset. */
  hubIcon?: string | ((name: string) => string)
  card(call: ToolCall, d: DetailOf<K>, now: number): Card
  /** Its line in a work group, after t3code's `workEntryDisplayLabel`. */
  step(call: ToolCall, d: DetailOf<K>): string
  /** A node drawn in place of the whole `tool` node (a one-agent delegation as its agent's row). */
  replaces?(call: ToolCall, d: DetailOf<K>, now: number): JSX.Element | undefined
  /** The exit code the call reports, for the head once it settled. */
  exit?(d: DetailOf<K>): number | undefined
  /** What a work group step opens with ahead of its card's body (a command the card's head held). */
  detailPrefix?(call: ToolCall, d: DetailOf<K>): JSX.Element | undefined
}

/** One call's view with its detail bound: what the shell and the work log ask of a call. */
export interface CallView {
  action(): Action
  card(now: number): Card
  step(): string
  replaces(now: number): JSX.Element | undefined
  exit(): number | undefined
  detailPrefix(): JSX.Element | undefined
}
