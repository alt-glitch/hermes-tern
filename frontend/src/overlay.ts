// The contract every floating panel (approval, clarify, pickers, completion
// list) implements. The app keeps a stack: the top overlay sees keys first,
// every overlay draws into the `layer` region, and `close()` removes it (and tells it, through
// `onClose`, so its timers and watches end with it).

import type { JSX, Key } from '@stencil-hq/tern'

/** One floating panel in the `layer` region. */
export interface Overlay {
  /** Unique among open overlays: the layer child's key. */
  readonly key: string
  /** Covers the transcript and takes every key (a question that must be answered). */
  readonly modal?: boolean
  /**
   * The `input` that takes Tern's caret while this overlay is on top, given
   * its node id; null for none. Unset: none for a modal overlay, else the composer.
   */
  focus?(id: string): string | null
  /** The overlay's node, keyed by `key`; `id` is its full node id (`layer.<key>`). */
  node(id: string): JSX.Element
  /** A key while this overlay is on top: true when it consumed the key. */
  onKey(key: Key): boolean
  /**
   * Ctrl+C while this overlay is on top: give the safe answer (deny, skip, cancel) and close.
   * Unset: the app closes the overlay.
   */
  cancel?(): void
  /**
   * The overlay left the stack: closed, or replaced by one with the same key. Ends what it runs
   * while open (a tick, a watch). Called once, after it is off the stack.
   */
  onClose?(): void
}

/** What overlays reach of the app. */
export interface OverlayHost {
  /** Pushes `overlay` on top, replacing an open overlay with the same key. */
  open(overlay: Overlay): void
  /** Removes this exact instance and calls its onClose; a no-op once it was closed or replaced. */
  close(overlay: Overlay): void
  /** Re-render after a state change made outside a key or event handler. */
  changed(): void
}
