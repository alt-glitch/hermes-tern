import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { paletteFor } from '../palette.js'
import { loadSettings, saveSettings } from '../settings.js'
import { STYLES } from '../view/styles.js'

describe('paletteFor', () => {
  it("sends nothing in Tern mode, so Tern's theme colors the surface", () => {
    expect(paletteFor('tern', { name: 'default' } as never)).toMatchObject({ dark: {}, light: {} })
  })

  it('keeps a skin to its semantic colors: no muted, dim or path text', () => {
    const { dark } = paletteFor('skin', { colors: { accent: '#3366ff' }, name: 'ocean' } as never)

    expect(Object.keys(dark ?? {}).sort()).toEqual(
      expect.arrayContaining(['accent', 'error', 'success', 'warning'])
    )
    expect(dark).not.toHaveProperty('muted')
    expect(dark).not.toHaveProperty('dim')
    expect(dark).not.toHaveProperty('statusLinePath')
  })
})

describe('STYLES', () => {
  // The vars Tern derives from the user's omp theme (and its fonts): a color named any other way
  // stays put when the theme changes.
  const TERN = /^(t[1-4]|l[1-4]|accent|accent-ink|accent-fill|ok|warn|bad|ink[2-4]?|card|raise|panel|page|code-bg|chip-bg|well|well-line|pop-bg|sf-card-bg|sf-shade|sf-c-[a-z]+|sf-p-[a-zA-Z]+|sans|mono)$/

  it("paints only with Tern's theme vars, so a theme change repaints the plugin too", () => {
    expect(STYLES).not.toMatch(/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(|\b(white|black)\b/i)

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
