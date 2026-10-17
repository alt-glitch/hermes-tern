import type { Key } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import { hudKey } from '../hud.js'

const key = (name: string, mods: Partial<Key> = {}): Key =>
  ({ alt: false, ctrl: false, meta: false, name, shift: false, ...mods }) as Key

const both = ['agents', 'shells'] as const

describe('hudKey', () => {
  it('focuses the first pill on Down from an idle prompt only', () => {
    expect(hudKey(key('down'), { idle: true, pills: both })).toEqual({ consumed: true, focused: 'agents' })
    // A draft, history being browsed or an open completion keep Down for the composer.
    expect(hudKey(key('down'), { idle: false, pills: both })).toEqual({ consumed: false })
    expect(hudKey(key('down'), { idle: true, pills: [] })).toEqual({ consumed: false })
    expect(hudKey(key('down', { meta: true }), { idle: true, pills: both })).toEqual({ consumed: false })
    // Up stays the history key.
    expect(hudKey(key('up'), { idle: true, pills: both })).toEqual({ consumed: false })
  })

  it('moves with Left/Right, opens with Enter, and returns with Esc or Up', () => {
    const at = { focused: 'agents' as const, idle: true, pills: both }

    expect(hudKey(key('right'), at)).toEqual({ consumed: true, focused: 'shells' })
    expect(hudKey(key('left'), at)).toEqual({ consumed: true, focused: 'agents' })
    expect(hudKey(key('right'), { ...at, focused: 'shells' })).toEqual({ consumed: true, focused: 'shells' })
    expect(hudKey(key('enter'), { ...at, focused: 'shells' })).toEqual({ consumed: true, open: 'shells' })
    expect(hudKey(key('escape'), at)).toEqual({ consumed: true })
    expect(hudKey(key('up'), at)).toEqual({ consumed: true })
  })

  it('hands any other key back to the composer, and lets go of a pill that left', () => {
    const at = { focused: 'shells' as const, idle: true, pills: both }

    expect(hudKey(key('a', { text: 'a' }), at)).toEqual({ consumed: false })
    expect(hudKey(key('enter', { shift: true }), at)).toEqual({ consumed: false })
    expect(hudKey(key('enter'), { ...at, pills: ['agents'] })).toEqual({ consumed: false })
  })
})
