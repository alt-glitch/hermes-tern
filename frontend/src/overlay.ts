// The contract every floating panel (approval, clarify, pickers, completion
// list) implements. The app keeps a stack: the top overlay sees keys first,
// every overlay draws into the `layer` region, and `close()` removes it.

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
}

/** What overlays reach of the app. */
export interface OverlayHost {
  /** Pushes `overlay` on top, replacing an open overlay with the same key. */
  open(overlay: Overlay): void
  /** Removes this exact instance; a no-op once it was closed or replaced. */
  close(overlay: Overlay): void
  /** Re-render after a state change made outside a key or event handler. */
  changed(): void
}
