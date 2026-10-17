// `/theme`: whose colors hermes wears. Tern's own theme by default; the Nous palette or the
// Hermes skin on request. The pick applies at once and is kept for the next launch.

import type { Key, PickerItem } from '@stencil-hq/tern'

import type { App } from '../app.js'
import type { Overlay } from '../overlay.js'
import type { ThemeMode } from '../settings.js'

import { moveSelection } from './search.js'

const KEY = 'theme'

const MODES: readonly (PickerItem & { id: ThemeMode })[] = [
  { detail: 'Your Tern theme, light and dark, with no colors of its own', icon: 'palette', id: 'tern', label: 'Tern' },
  { detail: 'Bone ink and quiet grays; gold only for the moments that earn it', icon: 'sparkle', id: 'nous', label: 'Nous' },
  { detail: "The Hermes skin's accent and status colors (/skin picks the skin)", icon: 'appearance', id: 'skin', label: 'Hermes skin' }
]

export function isThemeMode(v: string): v is ThemeMode {
  return MODES.some(m => m.id === v)
}

/** Opens the theme picker; the selection previews live and Esc puts the old mode back. */
export function openThemePicker(app: App) {
  const before = app.theme
  let selected: ThemeMode = before

  const pick = (mode: ThemeMode | undefined) => {
    if (mode) {
      selected = mode
      app.setTheme(mode)
    }
  }

  const overlay: Overlay = {
    key: KEY,
    modal: true,
    // As Esc: the theme being previewed goes back.
    cancel: () => {
      app.setTheme(before)
      app.close(overlay)
    },
    node: () => (
      <picker
        actions={[
          { end: true, id: 'cancel', keys: ['esc'], label: 'Cancel' },
          { id: 'use', keys: ['enter'], label: 'Use', primary: true }
        ]}
        current={[before]}
        icon="palette"
        items={[...MODES]}
        key={KEY}
        noun="themes"
        onAction={{
          cancel: () => {
            app.setTheme(before)
            app.close(overlay)
          },
          close: () => app.close(overlay),
          use: () => app.close(overlay)
        }}
        onActivate={ev => {
          pick(ev.item as ThemeMode)
          app.close(overlay)
        }}
        onSelect={ev => pick(ev.item as ThemeMode)}
        selected={selected}
        size="md"
        title="Theme"
      />
    ),
    onKey: (k: Key) => {
      if (k.name === 'escape') {
        app.setTheme(before)
        app.close(overlay)
      } else if (k.name === 'enter') {
        app.close(overlay)
      } else {
        pick(moveSelection(k, MODES.map(m => m.id), selected) as ThemeMode | undefined)
      }

      return true
    }
  }

  app.open(overlay)
}
