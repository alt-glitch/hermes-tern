import { describe, expect, it } from 'vitest'

import { Composer } from '../composer.js'
import { maskedOffset, maskOf, unmaskEdit } from '../mask.js'

// 'a', a family emoji (one grapheme, 11 UTF-16 units), '🔑' (2 units), 'b'.
const FAMILY = '👨‍👩‍👧'
const SECRET = `a${FAMILY}🔑b`

describe('masked fields', () => {
  it('draws one bullet per grapheme', () => {
    expect(maskOf(SECRET)).toBe('••••')
    expect(maskOf('')).toBe('')
  })

  it('maps the real caret to the bullets before it', () => {
    expect(maskedOffset(SECRET, 0)).toBe(0)
    expect(maskedOffset(SECRET, 1)).toBe(1)
    expect(maskedOffset(SECRET, 1 + FAMILY.length)).toBe(2)
    expect(maskedOffset(SECRET, SECRET.length - 1)).toBe(3)
    expect(maskedOffset(SECRET, SECRET.length)).toBe(4)
  })

  it('a native backspace over a bullet deletes the whole grapheme, never half a pair', () => {
    const c = new Composer()
    c.set(SECRET)
    // Tern deletes the third bullet (🔑): masked [2, 3), caret 2, over a 4-bullet text.
    const edit = unmaskEdit(c.text, { cursor: 2, from: 2, len: 4, text: '', to: 3 })
    expect(edit).not.toBeNull()
    c.edit(edit!)
    expect(c.text).toBe(`a${FAMILY}b`)
    expect(c.cursor).toBe(1 + FAMILY.length)
  })

  it('typing between bullets inserts at the real grapheme boundary', () => {
    const c = new Composer()
    c.set(SECRET)
    // Typed "xy" after the second bullet: Tern's text is `••xy••`, caret 4.
    c.edit(unmaskEdit(c.text, { cursor: 4, from: 2, len: 4, text: 'xy', to: 2 })!)
    expect(c.text).toBe(`a${FAMILY}xy🔑b`)
    expect(c.cursor).toBe(1 + FAMILY.length + 2)
    expect(maskedOffset(c.text, c.cursor)).toBe(4)
  })

  it('maps a caret past the edit back through the bullets after it', () => {
    // Replace bullet 0 with 'Z', caret left at the end of `Z•••` (4).
    const edit = unmaskEdit(SECRET, { cursor: 4, from: 0, len: 4, text: 'Z', to: 1 })
    expect(edit).toEqual({ cursor: SECRET.length, from: 0, len: SECRET.length, text: 'Z', to: 1 })
  })

  it('ignores an edit of a mask that is out of date', () => {
    expect(unmaskEdit(SECRET, { cursor: 1, from: 0, len: SECRET.length, text: 'x', to: 0 })).toBeNull()
  })
})
