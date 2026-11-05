import { describe, expect, it, vi } from 'vitest'

import { Composer } from '../draft/composer.js'
import { openPromptHistorySearch } from '../overlays/historySearch.js'
import { OverlayStack, type Overlay, type OverlayHost } from '../overlays/overlay.js'
import { APP_SHORTCUTS, shortcutMatches } from '../shortcuts/actions.js'

import { key } from './fakes.js'

function fixture(history: readonly string[]) {
  const composer = new Composer()
  const changed = vi.fn()
  const stack = new OverlayStack({ changed, closed: vi.fn(), opened: vi.fn() })
  const host: OverlayHost = {
    changed,
    close: (overlay: Overlay) => stack.close(overlay),
    open: (overlay: Overlay) => stack.open(overlay)
  }

  openPromptHistorySearch(host, composer, history)
  const overlay = stack.items[0]

  if (!overlay) throw new Error('Expected prompt history overlay')
  return { changed, composer, overlay, root: stack.rootOf(overlay), stack }
}

function type(overlay: Overlay, value: string) {
  for (const ch of value) overlay.onKey(key(ch, { text: ch }))
}

describe('Ctrl+R prompt-history search', () => {
  it('ranks full-text fuzzy matches and keeps newest-first ties', () => {
    const f = fixture(['alpha test', 'test later', 'test newest', 'misc'])
    const shortcut = APP_SHORTCUTS.find(row => row.id === 'app.history.search')

    expect(shortcut && shortcutMatches(shortcut, key('r', { ctrl: true }))).toBe(true)
    type(f.overlay, 'TEST')
    const view = JSON.stringify(f.overlay.node(f.root))
    expect(view).toContain('"query":"TEST"')
    // Test at offset 0 scores 125; test at offset 6 scores 119.
    // Two equal 125 scores retain newest-first source order: 2, 1, then 0.
    expect(view).toContain('"order":["2","1","0"]')
    f.overlay.onKey(key('u', { ctrl: true }))
    type(f.overlay, 'tst')
    // Scattered t-s-t also matches all three, with stable recency ties.
    expect(JSON.stringify(f.overlay.node(f.root))).toContain('"order":["2","1","0"]')
  })

  it('Enter fills the draft, never takes or submits it', () => {
    const f = fixture(['run deployment', 'review pull request'])
    f.composer.set('unsent', { cursor: 2 })
    const take = vi.spyOn(f.composer, 'take')

    f.overlay.onKey(key('down'))
    f.overlay.onKey(key('enter'))

    expect(f.composer.text).toBe('run deployment')
    expect(f.composer.cursor).toBe('run deployment'.length)
    expect(f.composer.literal).toBe(true)
    expect(take).not.toHaveBeenCalled()
    expect(f.stack.items).toHaveLength(0)
  })

  it('Escape keeps the draft, caret, paste markers and revision unchanged', () => {
    const f = fixture(['prior prompt', 'another prompt'])
    f.composer.set('draft {!date}', { cursor: 5, pasted: ['{!date}'], literal: true })
    const before = f.composer.revision
    const set = vi.spyOn(f.composer, 'set')

    type(f.overlay, 'prior')
    f.overlay.node(f.root)
    f.overlay.onKey(key('escape'))

    expect(f.composer.text).toBe('draft {!date}')
    expect(f.composer.cursor).toBe(5)
    expect(f.composer.pasted).toEqual(['{!date}'])
    expect(f.composer.literal).toBe(true)
    expect(f.composer.revision).toBe(before)
    expect(set).not.toHaveBeenCalled()
    expect(f.stack.items).toHaveLength(0)
  })
})
