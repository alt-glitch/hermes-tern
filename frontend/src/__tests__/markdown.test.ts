import type { Key } from '@stencil-hq/tern'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Composer } from '../composer.js'
import { listNewline, markdownDecor, toggleMark } from '../markdown.js'

const history: string[] = []

vi.mock('@tui/lib/history.js', () => ({
  append: (text: string) => void history.push(text),
  load: () => history
}))

function key(name: string, mods: Partial<Key> = {}): Key {
  return { alt: false, ctrl: false, meta: false, name, shift: false, ...mods } as Key
}

/** Each decor run as `text:tokens`. */
const styled = (text: string) => markdownDecor(text).map(d => `${text.slice(d.from, d.to)}:${d.s}`)

beforeEach(() => {
  history.length = 0
})

describe('markdownDecor', () => {
  it('styles bold, italic and code, with their markers dim', () => {
    expect(styled('a **bold** and _it_ and `x*y*`')).toEqual([
      '**:dim',
      'bold:strong',
      '**:dim',
      '_:dim',
      'it:em',
      '_:dim',
      '`:dim',
      'x*y*:code',
      '`:dim'
    ])
  })

  it('combines nested marks into one run, never overlapping ranges', () => {
    const decor = markdownDecor('**bold _both_**')
    expect(styled('**bold _both_**')).toEqual(['**:dim', 'bold :strong', '_:strong dim', 'both:strong em', '_:strong dim', '**:dim'])

    for (let i = 1; i < decor.length; i++) {
      expect(decor[i]!.from).toBeGreaterThanOrEqual(decor[i - 1]!.to)
    }
  })

  it('styles headings, quotes, list markers and task boxes', () => {
    expect(styled('# Title')).toEqual(['#:dim', 'Title:strong'])
    expect(styled('> said')).toEqual(['> :dim', 'said:muted'])
    expect(styled('- [ ] todo\n12. next')).toEqual(['-:accent', '[ ]:accent', '12.:accent'])
  })

  it('shows a fenced block as code and leaves Markdown inside it alone', () => {
    expect(styled('```ts\nconst a = **b**\n```')).toEqual(['```ts:dim', 'const a = **b**:code', '```:dim'])
  })

  it('reads snake_case and 2*3*4 as text', () => {
    expect(styled('use snake_case_name here')).toEqual([])
    expect(styled('2 * 3 * 4')).toEqual([])
  })

  it('styles a link label, dims its URL', () => {
    expect(styled('see [docs](https://x.y) now')).toEqual(['[:dim', 'docs:link', '](https://x.y):dim'])
  })
})

describe('listNewline', () => {
  it('continues bullets, numbers and task items with their indentation', () => {
    expect(listNewline('- one', 5)).toMatchObject({ text: '\n- ' })
    expect(listNewline('  * one', 7)).toMatchObject({ text: '\n  * ' })
    expect(listNewline('9. one', 6)).toMatchObject({ text: '\n10. ' })
    expect(listNewline('1) one', 6)).toMatchObject({ text: '\n2) ' })
    expect(listNewline('- [x] done', 10)).toMatchObject({ text: '\n- [ ] ' })
  })

  it('ends the list on an empty item, and is plain outside a list or inside the marker', () => {
    expect(listNewline('- one\n- ', 8)).toEqual({ cursor: 6, from: 6, text: '', to: 8 })
    expect(listNewline('plain', 5)).toBeUndefined()
    expect(listNewline('- one', 1)).toBeUndefined()
  })
})

describe('toggleMark', () => {
  it('wraps a selection, and unwraps it again', () => {
    const on = toggleMark('make it bold', 8, 12, '**')
    expect(on).toEqual({ anchor: 10, cursor: 14, from: 8, text: '**bold**', to: 12 })

    const text = 'make it **bold**'
    expect(toggleMark(text, 10, 14, '**')).toEqual({ anchor: 8, cursor: 12, from: 8, text: 'bold', to: 16 })
    expect(toggleMark(text, 8, 16, '**')).toEqual({ anchor: 8, cursor: 12, from: 8, text: 'bold', to: 16 })
  })

  it('at the caret: opens an empty pair, steps out at its end, unwraps inside a run', () => {
    expect(toggleMark('ab', 2, 2, '**')).toEqual({ cursor: 4, from: 2, text: '****', to: 2 })
    expect(toggleMark('ab****', 4, 4, '**')).toEqual({ cursor: 2, from: 2, text: '', to: 6 })
    expect(toggleMark('**x**', 3, 3, '**')).toEqual({ cursor: 5, from: 3, text: '', to: 3 })
    expect(toggleMark('a _word_ b', 4, 4, '_')).toEqual({ cursor: 3, from: 2, text: 'word', to: 8 })
  })
})

describe('Composer: Markdown editing', () => {
  it('⌘B and ⌘I toggle bold and italic on a Shift+arrow selection', () => {
    const c = new Composer()
    c.set('make it bold')
    for (let i = 0; i < 4; i++) {
      c.key(key('left', { shift: true }))
    }
    expect(c.selection).toEqual([8, 12])

    c.key(key('b', { meta: true }))
    expect(c.text).toBe('make it **bold**')
    expect(c.selection).toEqual([10, 14])

    c.key(key('b', { meta: true }))
    expect(c.text).toBe('make it bold')

    c.key(key('i', { meta: true }))
    expect(c.text).toBe('make it _bold_')
    c.undo()
    expect(c.text).toBe('make it bold')
  })

  it('⌘B at the caret opens bold for what is typed next, and a second ⌘B leaves it', () => {
    const c = new Composer()
    c.key(key('b', { meta: true }))
    for (const ch of 'hi') {
      c.key(key(ch, { text: ch }))
    }
    c.key(key('b', { meta: true }))
    c.key(key('!', { text: '!' }))
    expect(c.text).toBe('**hi**!')
  })

  it('takes a native selection anchor from Tern, and typing replaces the selection', () => {
    const c = new Composer()
    c.set('hello world')
    c.edit({ cursor: 11, from: 11, len: 11, raw: { anchor: 6 }, text: '', to: 11 })
    expect(c.selection).toEqual([6, 11])

    c.key(key('x', { text: 'X' }))
    expect(c.text).toBe('hello X')
    expect(c.anchor).toBeUndefined()
  })

  it('continues a list on Shift+Enter and on a native new line; an empty item ends it', () => {
    const c = new Composer()
    c.set('- one')
    c.key(key('enter', { shift: true }))
    expect(c.text).toBe('- one\n- ')
    c.key(key('enter', { shift: true }))
    expect(c.text).toBe('- one\n')

    c.set('1. a')
    c.edit({ cursor: 5, from: 4, len: 4, text: '\n', to: 4 })
    expect(c.text).toBe('1. a\n2. ')
    expect(c.cursor).toBe(8)

    c.set('- [ ] a\\')
    c.key(key('enter'))
    expect(c.text).toBe('- [ ] a\n- [ ] ')
  })

  it('Enter still sends, and the text sent stays plain Markdown', () => {
    const c = new Composer()
    c.set('- **one**')
    expect(c.key(key('enter'))).toBe('submit')
    expect(c.take()).toBe('- **one**')
  })

  it('keeps a long Markdown paste verbatim, as one undo step', () => {
    const c = new Composer()
    const paste = Array.from({ length: 400 }, (_, i) => `${i + 1}. **item** with \`code\`\n   - [ ] nested`).join('\r\n')
    c.key(key('paste', { text: paste }))

    expect(c.text).toBe(paste.replace(/\r\n/g, '\n'))
    expect(c.decor.length).toBeGreaterThan(400)
    c.undo()
    expect(c.text).toBe('')
  })
})
