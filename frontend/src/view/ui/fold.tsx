// Nodes headed by one of their own children. Tern takes a section's or a card's `head` as spans,
// or as the id of a child to draw there: a row with icons and timers, which spans cannot hold.
// The SDK types `head` as spans only, so these are the one place that builds a head by id.

import { type Children, type JSX, node, type Tone } from '@stencil-hq/tern'

/** A node whose head is its child keyed `head`. */
export interface HeadedProps {
  /** The node's own id (its parent's id, `.`, its key): the head's id derives from it. */
  id: string
  key: string
  role: string
  /** The head row; its key must be `head`. */
  head: JSX.Element
  body: Children
}

/** A section folded until a click, headed by `head`: Tern keeps its open state. */
export function foldSection(f: HeadedProps): JSX.Element {
  return node('section', { collapsed: true, collapsible: true, head: `${f.id}.head`, key: f.key, role: f.role }, [f.head, f.body])
}

/** A card headed by `head`, in `tone`. */
export function headedCard(c: HeadedProps & { tone: Tone }): JSX.Element {
  return node('card', { head: `${c.id}.head`, key: c.key, role: c.role, tone: c.tone }, [c.head, c.body])
}
