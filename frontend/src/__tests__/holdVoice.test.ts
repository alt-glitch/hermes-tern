import { KeyDecoder } from '@stencil-hq/tern'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { HOLD_UNAVAILABLE, isHoldInfoKey } from '../voice/hold.js'

import { setup } from './appSetup.js'
import { key } from './fakes.js'

vi.mock('@hermes/shared/prompt-history', () => ({ append: () => undefined, load: () => [] }))

beforeEach(() => {
  delete process.env['HERMES_TERN_QUERY']
  delete process.env['HERMES_TERN_IMAGE']
})

describe('real PTT release capability gate', () => {
  it('installed KeyDecoder cannot distinguish Space press, repeat and release', () => {
    const decoder = new KeyDecoder()
    const keys = [1, 2, 3].map(phase => decoder.feed(Buffer.from('\x1b[32;1:' + phase + 'u')))
    expect(keys[0]).toEqual([key('space', { text: ' ' })])
    expect(keys[1]).toEqual(keys[0])
    expect(keys[2]).toEqual(keys[0])
  })

  it('Alt+Shift+Space explains missing hold without ever starting a microphone', async () => {
    const { app, press, sent } = setup()
    expect(isHoldInfoKey(key('space', { alt: true, shift: true }))).toBe(true)
    expect(isHoldInfoKey(key('space', { text: ' ' }))).toBe(false)
    await press(key('space', { alt: true, shift: true }))
    expect(app.transcript.entries.some(e => e.kind === 'notice' && e.text.includes('key-down/key-up'))).toBe(true)
    expect(sent('voice.live.start')).toHaveLength(0)
    expect(sent('voice.dictate.start')).toHaveLength(0)
    expect(HOLD_UNAVAILABLE).toContain('unavailable')
  })

  it('short taps and Space repeats remain composer text, not fake holds', async () => {
    const { app, press, sent } = setup()
    await press(key('space', { text: ' ' }))
    await press(key('space', { text: ' ' }))
    expect(app.stores.composer.text).toBe('  ')
    expect(sent('voice.live.start')).toHaveLength(0)
  })
})
