import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SkinPayload } from '@hermes/shared/gateway-events'
import type { Palette } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { Theme } from '../chrome/theme.js'
import { paletteFor } from '../palette.js'
import { loadSettings, saveSettings } from '../settings.js'
import { STYLES } from '../view/styles.js'

import { stub } from './fakes.js'

describe('paletteFor', () => {
  it("sends nothing in Tern mode, so Tern's theme colors the surface", () => {
    expect(paletteFor('tern', stub({ name: 'default' }))).toMatchObject({ dark: {}, light: {} })
  })

  it('keeps a skin to its semantic colors: no muted, dim or path text', () => {
    const { dark } = paletteFor('skin', stub({ colors: { accent: '#3366ff' }, name: 'ocean' }))

    expect(Object.keys(dark ?? {}).sort()).toEqual(
      expect.arrayContaining(['accent', 'error', 'success', 'warning'])
    )
    expect(dark).not.toHaveProperty('muted')
    expect(dark).not.toHaveProperty('dim')
    expect(dark).not.toHaveProperty('statusLinePath')
  })
})

describe('Theme', () => {
  const skin: SkinPayload = { colors: { accent: '#3366ff' }, name: 'ocean' }

  /** A host that keeps each palette sent and each settings write. */
  function host() {
    const sent: Palette[] = []
    const saved: unknown[] = []

    return {
      palette: (p: Palette) => void sent.push(p),
      saved,
      sent,
      settings: { save: (patch: object) => (saved.push(patch), {}) }
    }
  }

  it('sends the palette of its mode and the skin, which only the skin mode wears', () => {
    const h = host()
    const theme = new Theme(h, 'tern')

    theme.apply()
    theme.skin(skin)
    expect(h.sent).toEqual([paletteFor('tern', undefined), paletteFor('tern', skin)])

    theme.set('skin')
    expect(theme.mode).toBe('skin')
    expect(h.sent.at(-1)).toEqual(paletteFor('skin', skin))
    expect(h.sent.at(-1)?.name).toEqual({ dark: 'ocean', light: 'ocean' })
    expect(h.saved).toEqual([{ theme: 'skin' }])
  })

  it('keeps the last skin when the gateway reports none', () => {
    const h = host()
    const theme = new Theme(h, 'skin')

    theme.skin(skin)
    theme.skin(null)
    theme.skin(undefined)
    expect(h.sent).toHaveLength(1)

    theme.set('nous')
    expect(h.sent.at(-1)).toEqual(paletteFor('nous', skin))
    theme.set('skin')
    expect(h.sent.at(-1)).toEqual(paletteFor('skin', skin))
  })
})

describe('STYLES', () => {
  // The vars Tern derives from the user's omp theme (and its fonts): a color named any other way
  // stays put when the theme changes.
  const TERN = /^(t[1-4]|l[1-4]|accent|accent-ink|accent-fill|ok|warn|bad|ink[2-4]?|card|raise|panel|page|code-bg|chip-bg|well|well-line|pop-bg|sf-card-bg|sf-shade|sf-c-[a-z]+|sf-p-[a-zA-Z]+|sans|mono)$/

  it("paints only with Tern's theme vars, so a theme change repaints the plugin too", () => {
    expect(STYLES).not.toMatch(/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(|(?<![\w-])(white|black)(?![\w-])/i)

    for (const [, name] of STYLES.matchAll(/var\(--([\w-]+)/g)) {
      expect(name).toMatch(TERN)
    }
  })
})

describe('settings', () => {
  it('reads defaults from a missing file and keeps what it saved', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'hermes-tern-settings-')), 'x', 'settings.json')

    expect(loadSettings(file)).toEqual({})
    saveSettings({ theme: 'nous' }, file)
    expect(loadSettings(file)).toEqual({ theme: 'nous' })
  })
})
