import type { Key } from '@stencil-hq/tern'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Composer } from '../composer.js'

const history: string[] = []

vi.mock('@tui/lib/history.js', () => ({
  append: (text: string) => void history.push(text),
  load: () => history
}))

function key(name: string, mods: Partial<Key> = {}): Key {
  return { alt: false, ctrl: false, meta: false, name, shift: false, ...mods } as Key
}

function typed(c: Composer, text: string) {
  for (const ch of text) {
    c.key(key(ch, { text: ch }))
  }
}

beforeEach(() => {
  history.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Composer', () => {
  it('deletes a whole emoji grapheme, not a surrogate half', () => {
    const c = new Composer()
    c.set('hi 👩‍👩‍👧!')
    c.key(key('left'))
    c.key(key('backspace'))
    expect(c.text).toBe('hi !')
    expect(c.cursor).toBe(3)
  })

  it('moves by words with Alt+arrows and Alt+B/F, and Ctrl+W kills one', () => {
    const c = new Composer()
    c.set('foo bar.baz qux')
    c.key(key('left', { alt: true }))
    expect(c.cursor).toBe(12)
    c.key(key('b', { alt: true }))
    expect(c.cursor).toBe(8)
    c.key(key('f', { alt: true }))
    expect(c.cursor).toBe(11)
    c.key(key('w', { ctrl: true }))
    expect(c.text).toBe('foo bar. qux')
    c.key(key('y', { ctrl: true }))
    expect(c.text).toBe('foo bar.baz qux')
  })

  it('Ctrl+K at a line end joins the next line', () => {
    const c = new Composer()
    c.set('ab\ncd', 2)
    c.key(key('k', { ctrl: true }))
    expect(c.text).toBe('abcd')
  })

  it('history browse restores the unsent draft', () => {
    history.push('first', 'second')
    const c = new Composer()
    typed(c, 'draft')
    c.key(key('up'))
    expect(c.text).toBe('second')
    c.key(key('up'))
    expect(c.text).toBe('first')
    c.key(key('down'))
    c.key(key('down'))
    expect(c.text).toBe('draft')
  })

  it('moves between lines before reaching history', () => {
    history.push('old')
    const c = new Composer()
    c.set('one\ntwo')
    c.key(key('up'))
    expect(c.text).toBe('one\ntwo')
    expect(c.cursor).toBe(3)
  })

  it('Home at offset 0 stays at 0 when the text starts with a newline', () => {
    const c = new Composer()
    c.set('\nab', 0)
    c.key(key('home'))
    expect(c.cursor).toBe(0)
    c.key(key('a', { ctrl: true }))
    expect(c.cursor).toBe(0)
  })

  it('Up/Down never land inside an emoji on the target line', () => {
    const c = new Composer()
    // Column 3 of the second line falls between the surrogate halves of 😀 (offsets 2–4) above it.
    c.set('ab😀c\nxyz')
    c.key(key('up'))
    expect(c.cursor).toBe(2)
    c.set('xyz\nab😀c', 3)
    c.key(key('down'))
    expect(c.cursor).toBe(6)
  })

  it('ignores an edit event whose len is stale', () => {
    const c = new Composer()
    c.set('hello')
    c.edit({ cursor: 1, from: 0, len: 4, text: 'X', to: 0 })
    expect(c.text).toBe('hello')
    c.edit({ cursor: 1, from: 0, len: 5, text: 'X', to: 0 })
    expect(c.text).toBe('Xhello')
  })

  it('merges a typing burst into one undo step, splits after the window', () => {
    vi.useFakeTimers()
    const c = new Composer()
    typed(c, 'abc')
    vi.advanceTimersByTime(2000)
    typed(c, 'de')
    c.undo()
    expect(c.text).toBe('abc')
    c.undo()
    expect(c.text).toBe('')
  })

  it('keeps a paste as its own undo step', () => {
    const c = new Composer()
    typed(c, 'a')
    c.key(key('paste', { text: 'x\r\ny'.repeat(1000) }))
    typed(c, 'b')
    c.undo()
    expect(c.text).toBe(`a${'x\ny'.repeat(1000)}`)
    c.undo()
    expect(c.text).toBe('a')
  })

  it('trailing backslash + Enter inserts a newline; Shift+Enter too; Enter submits', () => {
    const c = new Composer()
    typed(c, 'a\\')
    expect(c.key(key('enter'))).toBe(true)
    expect(c.text).toBe('a\n')
    c.key(key('enter', { shift: true }))
    expect(c.text).toBe('a\n\n')
    expect(c.key(key('enter'))).toBe('submit')
  })
})
