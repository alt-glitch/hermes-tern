// The pane's one inline surface on a Tern session, as the chat and the subagent pane both open it:
// role `omp.session` (so Tern's chat styles apply) with this frontend's stylesheet (view/styles.ts,
// which the pane hands in), and the caret sent only when it moves.

import type { Palette, Renderable, RevealAt, ScrollTo, Session, Surface } from '@stencil-hq/tern'

/** The composer's node id (dock → composer): the completion list sits above it. */
export const COMPOSER_ID = 'dock.composer'

/** The composer's `editor` node id (dock → composer → line → input): where the caret rests. */
export const INPUT_ID = `${COMPOSER_ID}.line.input`

/** The surface a pane draws on, with the field holding Tern's caret as last sent. */
export class SurfaceHost {
  readonly #surface: Surface
  #focus: string | null = INPUT_ID

  /** Opens the surface on `tern`, titled `title` (the tab's name until a program sets one), wearing `styles`. */
  constructor(tern: Session, title: string, styles: string) {
    this.#surface = tern.open({ id: 'hermes', mode: 'inline', role: 'omp.session', title })
    this.#surface.stylesheet('hermes-tern', styles)
  }

  /** Whether Tern dropped the surface or it was closed: it draws nothing more. */
  get closed(): boolean {
    return this.#surface.closed
  }

  render(view: Renderable) {
    this.#surface.render(view)
  }

  palette(palette: Palette) {
    this.#surface.palette(palette)
  }

  /** Gives the caret to `id` (or to none) now, sent even when it is already there. */
  focus(id: string | null) {
    this.#focus = id
    this.#surface.focus(id)
  }

  /** Gives the caret to `id` when it is somewhere else: what each render does. */
  follow(id: string | null) {
    if (id !== this.#focus) {
      this.focus(id)
    }
  }

  reveal(id: string, at?: RevealAt) {
    this.#surface.reveal(id, at)
  }

  scroll(id: string, to: ScrollTo) {
    this.#surface.scroll(id, to)
  }
}
