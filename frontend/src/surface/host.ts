// The pane's one inline surface on a Tern session, as the chat and the subagent pane both open it:
// role `omp.session` (so Tern's chat styles apply) with this frontend's stylesheet, and the caret
// sent only when it moves.

import type { Palette, Renderable, RevealAt, ScrollTo, Session, Surface } from '@stencil-hq/tern'

import { STYLES } from '../view/styles.js'

/** The composer's `editor` node id (dock → composer → line → input): where the caret rests. */
export const INPUT_ID = 'dock.composer.line.input'

/** The surface a pane draws on, with the field holding Tern's caret as last sent. */
export class SurfaceHost {
  readonly #surface: Surface
  #focus: string | null = INPUT_ID

  /** Opens the surface on `tern`, titled `title` (the tab's name until a program sets one). */
  constructor(tern: Session, title: string) {
    this.#surface = tern.open({ id: 'hermes', mode: 'inline', role: 'omp.session', title })
    this.#surface.stylesheet('hermes-tern', STYLES)
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
