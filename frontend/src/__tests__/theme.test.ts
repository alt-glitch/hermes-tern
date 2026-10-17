import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { paletteFor } from '../palette.js'
import { loadSettings, saveSettings } from '../settings.js'

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

describe('settings', () => {
  it('reads defaults from a missing file and keeps what it saved', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'hermes-tern-settings-')), 'x', 'settings.json')

    expect(loadSettings(file)).toEqual({})
    saveSettings({ theme: 'nous' }, file)
    expect(loadSettings(file)).toEqual({ theme: 'nous' })
  })
})
