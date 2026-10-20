// The contract every floating panel (approval, clarify, pickers, completion
// list) implements. The app keeps a stack: the top overlay sees keys first,
// every overlay draws into the `layer` region, and `close()` removes it (and tells it, through
// `onClose`, so its timers and watches end with it). OverlayStack is that stack.

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

/** What the stack tells the app: an overlay opened or left, and that the view changed. */
export interface OverlayStackHost {
  /** `overlay` is on top now (after any same-key one left). */
  opened(overlay: Overlay): void
  /** `overlay` left the stack, before its own onClose runs. */
  closed(overlay: Overlay): void
  changed(): void
}

/** The open overlays, bottom first: a newer one with a key already open replaces it. */
export class OverlayStack implements Pick<OverlayHost, 'close' | 'open'> {
  /** The overlays, bottom first; changed only through open() and close(). */
  readonly items: Overlay[] = []
  readonly #host: OverlayStackHost

  constructor(host: OverlayStackHost) {
    this.#host = host
  }

  open(overlay: Overlay) {
    const same = this.items.find(o => o.key === overlay.key)

    if (same) {
      this.close(same)
    }

    this.items.push(overlay)
    this.#host.opened(overlay)
    this.#host.changed()
  }

  close(overlay: Overlay) {
    // By identity: a stale callback of a replaced overlay must not close its same-key successor.
    const at = this.items.indexOf(overlay)

    if (at >= 0) {
      this.items.splice(at, 1)
      this.#host.closed(overlay)
      overlay.onClose?.()
      this.#host.changed()
    }
  }
}
