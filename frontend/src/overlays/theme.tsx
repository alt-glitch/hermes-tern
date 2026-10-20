// `/theme`: whose colors hermes wears. Tern's own theme by default; the Nous palette or the
// Hermes skin on request. The pick applies at once and is kept for the next launch.

import type { Key, PickerItem } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import type { Overlay } from '../overlay.js'
import type { ThemeMode } from '../settings.js'

import { moveSelection } from './search.js'

/** What the theme picker reaches of the app. */
export type ThemeHost = Pick<ChatPorts, 'close' | 'open' | 'setTheme' | 'theme'>

const KEY = 'theme'

const MODES: readonly (PickerItem & { id: ThemeMode })[] = [
  { detail: 'Your Tern theme, light and dark, with no colors of its own', icon: 'palette', id: 'tern', label: 'Tern' },
  { detail: 'Bone ink and quiet grays; gold only for the moments that earn it', icon: 'sparkle', id: 'nous', label: 'Nous' },
  { detail: "The Hermes skin's accent and status colors (/skin picks the skin)", icon: 'appearance', id: 'skin', label: 'Hermes skin' }
]

export function isThemeMode(v: string): v is ThemeMode {
  return MODES.some(m => m.id === v)
}

/** The mode a picker row names; undefined for none (or a row this picker does not list). */
const modeOf = (item: string | undefined): ThemeMode | undefined => (item !== undefined && isThemeMode(item) ? item : undefined)

/** Opens the theme picker; the selection previews live and Esc puts the old mode back. */
export function openThemePicker(host: ThemeHost) {
  const before = host.theme
  let selected: ThemeMode = before

  const pick = (mode: ThemeMode | undefined) => {
    if (mode) {
      selected = mode
      host.setTheme(mode)
    }
  }

  const overlay: Overlay = {
    key: KEY,
    modal: true,
    // As Esc: the theme being previewed goes back.
    cancel: () => {
      host.setTheme(before)
      host.close(overlay)
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
            host.setTheme(before)
            host.close(overlay)
          },
          close: () => host.close(overlay),
          use: () => host.close(overlay)
        }}
        onActivate={ev => {
          pick(modeOf(ev.item))
          host.close(overlay)
        }}
        onSelect={ev => pick(modeOf(ev.item))}
        selected={selected}
        size="md"
        title="Theme"
      />
    ),
    onKey: (k: Key) => {
      if (k.name === 'escape') {
        host.setTheme(before)
        host.close(overlay)
      } else if (k.name === 'enter') {
        host.close(overlay)
      } else {
        pick(modeOf(moveSelection(k, MODES.map(m => m.id), selected)))
      }

      return true
    }
  }

  host.open(overlay)
}
