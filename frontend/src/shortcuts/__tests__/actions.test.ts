import { describe, expect, it } from 'vitest'

import { key } from '../../__tests__/fakes.js'

import { APP_SHORTCUTS, effectiveShortcuts, normalizeChord, shortcutGroups, shortcutMatches } from '../actions.js'

const action = (id: string, overrides: unknown = {}) => {
  const found = effectiveShortcuts(overrides).find(item => item.id === id)

  if (!found) {
    throw new Error(`Missing app action ${id}`)
  }

  return found
}

describe('Tern app action registry', () => {
  it('keeps the plugin key ownership and exact new chords', () => {
    expect(effectiveShortcuts({})).toEqual(APP_SHORTCUTS)
    expect(shortcutMatches(action('app.prs'), key('p', { alt: true, shift: true }))).toBe(false)
    for (const chord of ['alt+shift+p', 'alt+shift+f']) {
      expect(() => effectiveShortcuts({ 'app.help': chord })).toThrow(/Fixed app/)
    }
    expect(shortcutMatches(action('app.prs'), key('p', { alt: true, ctrl: true }))).toBe(false)
    expect(shortcutMatches(action('app.model.cycleBackward'), key('p', { ctrl: true, alt: true }))).toBe(true)
    expect(shortcutMatches(action('app.model.cycleBackward'), key('p', { ctrl: true, shift: true }))).toBe(false)
    expect(shortcutMatches(action('app.palette'), key('k', { alt: true }))).toBe(true)
    expect(shortcutMatches(action('app.palette'), key('k', { ctrl: true, shift: true }))).toBe(false)
    expect(shortcutMatches(action('app.help'), key('f1'))).toBe(true)
  })

  it('normalizes ordering/aliases and refuses host-reserved and editing keys', () => {
    expect(normalizeChord('Shift+CONTROL+N')).toBe('ctrl+shift+n')
    expect(normalizeChord('OPTION+M')).toBe('alt+m')
    for (const value of ['meta+k', 'cmd+h', 'super+p', 'ctrl+shift+c', 'ctrl+shift+v', 'ctrl+shift+p', 'shift+control+k', 'alt+tab', 'ctrl+ctrl+p']) {
      expect(() => normalizeChord(value)).toThrow()
    }
    for (const value of ['j', 'space', 'enter', 'ctrl+a', 'ctrl+g', 'alt+b', 'alt+enter', 'up']) {
      expect(() => effectiveShortcuts({ 'app.help': value })).toThrow(/Composer-owned/)
    }
  })

  it('keeps Ctrl+R app-owned through rebind, disable, reset and collision validation', () => {
    const id = 'app.history.search'
    expect(shortcutMatches(action(id), key('r', { ctrl: true }))).toBe(true)
    const moved = action(id, { [id]: 'ctrl+alt+r' })
    expect(shortcutMatches(moved, key('r', { ctrl: true }))).toBe(false)
    expect(shortcutMatches(moved, key('r', { ctrl: true, alt: true }))).toBe(true)
    expect(action(id, { [id]: [] }).keys).toEqual([])
    expect(action(id, { [id]: null }).keys).toEqual(['ctrl+r'])
    expect(() => effectiveShortcuts({ 'app.palette': 'ctrl+r' })).toThrow(/Overlapping/)
    const released = effectiveShortcuts({ [id]: [], 'app.palette': 'ctrl+r' })
    expect(released.find(item => item.id === 'app.palette')?.keys).toEqual(['ctrl+r'])
  })

  it('applies disable, reset, and rebinding atomically', () => {
    const changed = effectiveShortcuts({ 'app.help': ['alt+h'] })
    expect(shortcutMatches(action('app.help', { 'app.help': ['alt+h'] }), key('h', { alt: true }))).toBe(true)
    expect(changed.find(item => item.id === 'app.help')?.keys).toEqual(['alt+h'])
    expect(action('app.help', { 'app.help': [] }).keys).toEqual([])
    expect(action('app.help', { 'app.help': null }).keys).toEqual(['f1', 'alt+/'])
    expect(() => effectiveShortcuts({ 'app.help': ['alt+h', 'option+h'] })).toThrow(/Duplicate/)
    expect(() => effectiveShortcuts({ 'app.help': ['alt+a'] })).toThrow(/Overlapping/)
    expect(() => effectiveShortcuts({ 'app.help': ['ctrl+shift+tab'] })).toThrow(/Composer-owned/)
    expect(() => effectiveShortcuts({ 'app.help': 'alt+h', 'unknown.action': 'alt+y' })).toThrow(/Unknown/)
    expect(() => effectiveShortcuts({ 'app.palette': 'ctrl+shift+k' })).toThrow(/Host-reserved/)
    expect(() => effectiveShortcuts({ 'app.model.cycleBackward': 'ctrl+shift+p' })).toThrow(/Host-reserved/)
    expect(shortcutGroups(changed).flatMap(group => group.rows).some(([keys, title]) => keys[0] === 'alt+h' && title === 'Commands and shortcuts')).toBe(true)
  })
})
