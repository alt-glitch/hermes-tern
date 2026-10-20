// The PR aside: the PR view docked at the chat pane's right edge (Tern's aside: a `prefs` sheet
// in the layer, the chat narrowed beside it), the view as the sheet's extra content. Tern gives
// it the width of its own Settings sheet, so dragging that sheet's edge resizes it. It takes no
// keys, the composer keeps them, so the chat goes on while a PR stays in view.

import type { JSX } from '@stencil-hq/tern'

import { PrView, type PrViewHost } from './view.js'

export class PrAside {
  readonly #host: PrViewHost
  #view: PrView | undefined

  /** `host` is what the PR view reaches; the aside lends it the same one. */
  constructor(host: PrViewHost) {
    this.#host = host
  }

  get open(): boolean {
    return this.#view !== undefined
  }

  show(focus?: string) {
    if (!this.#view) {
      this.#view = new PrView(this.#host)
    }

    if (focus) {
      this.#view.select(focus)
    }

    this.#host.prs.poke()
    this.#host.changed()
  }

  close() {
    this.#view?.dispose()
    this.#view = undefined
    this.#host.changed()
  }

  node(id: string): JSX.Element | null {
    const view = this.#view

    if (!view) {
      return null
    }

    const now = Date.now()
    const current = view.current()

    return (
      <prefs
        key="prs"
        onAction={{
          close: (ev: { value?: unknown }) => {
            if (!ev.value) {
              this.close()
            }
          }
        }}
        page="pr"
        pages={[]}
        role="hermes.pr.aside"
        sections={[]}
        title={current ? `${current.ref.repository.split('/')[1] ?? current.ref.repository} #${current.ref.number}` : 'Pull requests'}
      >
        <col gap="md" key="view" role="hermes.pr.asideview">
          {view.switcher(true)}
          {view.header(now)}
          {view.tabBar()}
          <col gap="md" key="body" role="hermes.pr.body">
            {view.body(`${id}.view.body`, now, 'narrow')}
          </col>
          {view.actions()}
        </col>
      </prefs>
    )
  }
}
