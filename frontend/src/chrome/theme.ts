// Whose colors the surface wears (`/theme`): the mode settings.json keeps, and the skin the gateway
// last reported, which only the `skin` mode wears. palette.ts maps the pair to Tern's palette.

import type { SkinPayload } from '@hermes/shared/gateway-events'
import type { Palette } from '@stencil-hq/tern'

import type { SettingsSource, ThemeMode } from '../settings.js'

import { paletteFor } from './palette.js'

/** What the theme reaches of the app. */
export interface ThemeHost {
  /** Sends the palette to the surface (the `t` verb). */
  palette(palette: Palette): void
  /** Where the mode is kept for the next launch. */
  readonly settings: Pick<SettingsSource, 'save'>
}

/** The theme mode and the gateway's skin, sent to the surface as one palette. */
export class Theme {
  readonly #host: ThemeHost
  #mode: ThemeMode
  /** The skin the gateway last reported; only the `skin` theme mode wears it. */
  #skin: SkinPayload | undefined

  /** `mode` is the one settings.json kept. */
  constructor(host: ThemeHost, mode: ThemeMode) {
    this.#host = host
    this.#mode = mode
  }

  /** Whose colors the surface wears. */
  get mode(): ThemeMode {
    return this.#mode
  }

  /** Sends the palette of the mode and skin now. */
  apply() {
    this.#host.palette(paletteFor(this.#mode, this.#skin))
  }

  /** The gateway's skin (gateway.ready, skin.changed); none keeps the last one. */
  skin(skin: SkinPayload | null | undefined) {
    if (skin) {
      this.#skin = skin
      this.apply()
    }
  }

  /** Switches the mode now and keeps it for the next launch. */
  set(mode: ThemeMode) {
    this.#mode = mode
    this.#host.settings.save({ theme: mode })
    this.apply()
  }
}
