import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Key } from '@stencil-hq/tern'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Composer } from '../draft/composer.js'

import { FakeGateway, fakeTern, given, key, settle } from './fakes.js'

const history: string[] = []

vi.mock('@tui/lib/history.js', () => ({
  append: (text: string) => void history.push(text),
  load: () => history
}))

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
    c.set('ab\ncd', { cursor: 2 })
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

  it('keeps an edited history entry as the draft on the next Up/Down', () => {
    history.push('first', 'second', 'third')
    const c = new Composer()
    c.key(key('up'))
    c.key(key('up'))
    expect(c.text).toBe('second')
    typed(c, '!')
    expect(c.browsing).toBe(false)
    // Down has nowhere to go from a draft: the edit stays.
    c.key(key('down'))
    expect(c.text).toBe('second!')
    // Up walks from the newest entry again, and Down brings the edit back.
    c.key(key('up'))
    expect(c.text).toBe('third')
    c.key(key('down'))
    expect(c.text).toBe('second!')
  })

  it('a cleared draft ends a history walk', () => {
    history.push('first', 'second')
    const c = new Composer()
    c.key(key('up'))
    c.set('')
    expect(c.browsing).toBe(false)
    c.key(key('up'))
    c.key(key('down'))
    expect(c.text).toBe('')
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
    c.set('\nab', { cursor: 0 })
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
    c.set('xyz\nab😀c', { cursor: 3 })
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

// WP24: a paste is the draft's only while the draft holds it.
describe('Composer: the pastes a draft holds', () => {
  it('forgets them when set() replaces the draft, unless the caller passes them', () => {
    const c = new Composer()
    c.key(key('paste', { text: '!rm -rf x' }))
    expect(c.pasted).toEqual(['!rm -rf x'])

    c.set('')
    expect(c.pasted).toEqual([])

    c.set('!rm -rf x', { pasted: ['!rm -rf x'] })
    expect(c.pasted).toEqual(['!rm -rf x'])
    expect(c.cursor).toBe(9)
  })

  it('keeps them in each undo step: undo and redo bring back the pastes the draft held then', () => {
    const c = new Composer()
    c.key(key('paste', { text: '!rm -rf x' }))
    c.set('')

    c.undo()
    expect([c.text, c.pasted]).toEqual(['!rm -rf x', ['!rm -rf x']])
    c.redo()
    expect([c.text, c.pasted]).toEqual(['', []])
    c.undo()
    expect(c.pasted).toEqual(['!rm -rf x'])
    // Undoing the paste itself leaves the draft from before it, which held none.
    c.undo()
    expect([c.text, c.pasted]).toEqual(['', []])
  })

  it('places the caret where set() says', () => {
    const c = new Composer()
    c.set('hello', { cursor: 2 })
    expect([c.text, c.cursor]).toEqual(['hello', 2])
  })

  it('a `!cmd` typed after Ctrl+C cleared a pasted one runs: the old paste is not the new draft', async () => {
    process.env['HERMES_HOME'] = mkdtempSync(join(tmpdir(), 'hermes-tern-composer-'))
    const { App } = await import('../app/chat.js')
    const gw = new FakeGateway({ replies: { 'shell.exec': () => ({ code: 0, stderr: '', stdout: 'hi' }) } })
    const tern = fakeTern()
    const app = new App(tern.session, gw.client, '')
    void app.run()
    given.session(app, 's1')
    const press = async (k: Key) => {
      await vi.waitFor(() => expect(tern.reading).toBe(true))
      tern.press(k)
      await settle(gw)
    }

    await press(key('paste', { text: '!echo hi' }))
    await press(key('c', { ctrl: true }))
    expect(app.stores.composer.text).toBe('')

    for (const ch of '!echo hi') {
      await press(key(ch, { text: ch }))
    }

    await press(key('enter'))

    expect(gw.sent('shell.exec')).toEqual([{ command: 'echo hi', session_id: 's1' }])
    expect(gw.sent('prompt.submit')).toEqual([])
  })

  it('a pasted `!cmd` that Ctrl+C cleared and Ctrl+Z brought back still goes as written, not to the shell', async () => {
    process.env['HERMES_HOME'] = mkdtempSync(join(tmpdir(), 'hermes-tern-composer-'))
    const { App } = await import('../app/chat.js')
    const gw = new FakeGateway({ replies: { 'shell.exec': () => ({ code: 0, stderr: '', stdout: 'hi' }) } })
    const tern = fakeTern()
    const app = new App(tern.session, gw.client, '')
    void app.run()
    given.session(app, 's1')
    const press = async (k: Key) => {
      await vi.waitFor(() => expect(tern.reading).toBe(true))
      tern.press(k)
      await settle(gw)
    }

    await press(key('paste', { text: '!echo hi' }))
    await press(key('c', { ctrl: true }))
    expect(app.stores.composer.text).toBe('')
    await press(key('z', { ctrl: true }))
    expect(app.stores.composer.text).toBe('!echo hi')

    await press(key('enter'))

    expect(gw.sent('shell.exec')).toEqual([])
    expect(gw.sent('prompt.submit')).toEqual([expect.objectContaining({ session_id: 's1', text: '!echo hi' })])
  })
})
