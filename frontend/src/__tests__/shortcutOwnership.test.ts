import { describe, expect, it, vi } from 'vitest'

import { storedSessionId } from '../core/ids.js'
import { openSettings } from '../overlays/settings.js'
import { effectiveShortcuts } from '../shortcuts/actions.js'
import { busy, settle, setup } from './appSetup.js'
import { given, key, must, tree } from './fakes.js'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))

async function configured(binding = 'ctrl+alt+c', overrides: Record<string, unknown> = {}) {
  const f = setup({
    'session.resume': () => ({ session_id: 's1', info: { stored_session_id: 's1', profile_name: 'work' }, revision: 1, execution_generation: 1 }),
    'config.get': p => p['key'] === 'full'
      ? { config: { display: { tern_keybindings: { 'app.help': binding, ...overrides } } } }
      : { value: p['key'] === 'approvals.mode' ? 'manual' : 'queue' }
  })
  await f.app.resume(storedSessionId('s1'))
  await vi.waitFor(() => expect(f.sent('config.get').some(p => p['key'] === 'full' && p['profile'] === 'work')).toBe(true))
  await settle()
  return f
}

describe('profile shortcut ownership through the App input loop', () => {
  it('opens Help for configured Ctrl+Alt+C without changing text, caret, paste or attachment', async () => {
    const f = await configured()
    await f.attach()
    f.app.stores.composer.set('draft at caret', { cursor: 4 })
    await f.press(key('paste', { text: '{!literal}' }))
    const composer = f.app.stores.composer
    const before = { text: composer.text, cursor: composer.cursor, pasted: [...composer.pasted] }
    const images = [...f.app.stores.attachments.items]
    await f.press(key('c', { ctrl: true, alt: true }))
    await vi.waitFor(() => expect(f.app.overlays.some(o => o.key === 'help')).toBe(true))
    expect({ text: composer.text, cursor: composer.cursor, pasted: [...composer.pasted] }).toEqual(before)
    expect(f.app.stores.attachments.items).toEqual(images)
    expect(images).toHaveLength(1)
    expect(f.sent('prompt.submit')).toEqual([])
    expect(f.sent('session.interrupt')).toEqual([])
  })

  it('does not cancel live voice on a modified chord; plain Ctrl+C still releases it first', async () => {
    const f = await configured()
    await f.type('voice draft')
    await f.press(key('v', { alt: true, shift: true }))
    expect(f.app.liveVoice.phase).toBe('consent')
    await f.press(key('c', { ctrl: true, alt: true }))
    await vi.waitFor(() => expect(f.app.overlays.some(o => o.key === 'help')).toBe(true))
    expect(f.app.liveVoice.phase).toBe('consent')
    await f.press(key('c', { ctrl: true }))
    expect(f.app.liveVoice.phase).toBe('idle')
    expect(f.app.stores.composer.text).toBe('voice draft')
    expect(f.sent('voice.live.start')).toEqual([])
  })

  it('respects a busy turn: configured chord opens Help without interrupting or dropping draft', async () => {
    const f = await configured()
    await f.type('working draft')
    given.busy(f.app.stores, { ...busy })
    await f.press(key('c', { ctrl: true, alt: true }))
    await vi.waitFor(() => expect(f.app.overlays.some(o => o.key === 'help')).toBe(true))
    expect(f.app.stores.composer.text).toBe('working draft')
    expect(f.sent('session.interrupt')).toEqual([])
    expect(f.app.stores.activity.busy).not.toBeNull()
  })

  it('lets approval modal own Ctrl+Alt+C without denying it or running the global shortcut', async () => {
    const f = await configured()
    await f.type('pending draft')
    const respond = vi.fn()
    f.emit('request', { fail: vi.fn(), id: 'r1', method: 'approval', params: { command: 'make', session_id: 's1' }, respond })
    await settle()
    expect(f.app.overlays).toHaveLength(1)
    await f.press(key('c', { ctrl: true, alt: true }))
    expect(respond).not.toHaveBeenCalled()
    expect(f.app.overlays.some(o => o.key === 'help')).toBe(false)
    expect(f.app.overlays).toHaveLength(1)
    expect(f.app.stores.composer.text).toBe('pending draft')
    await f.press(key('c', { ctrl: true }))
    expect(respond).toHaveBeenCalledWith({ choice: 'deny' })
    expect(f.app.stores.composer.text).toBe('pending draft')
  })

  it('keeps a settings confirmation open on modified Ctrl+C while the modal owns input', async () => {
    const f = await configured()
    await f.type('unsent')
    openSettings(f.app)
    await vi.waitFor(() => expect(f.sent('config.get').some(p => p['key'] === 'skin')).toBe(true))
    await settle()
    await f.press(key('tab'))
    await f.press(key('tab'))
    await f.press(key('enter'))
    await f.press(key('down'))
    await f.press(key('enter'))
    const sheet = must(f.app.overlays.find(o => o.key === 'settings'))
    expect(tree(sheet.node('layer.settings')).k).toBe('overlay')
    await f.press(key('c', { ctrl: true, alt: true }))
    expect(tree(sheet.node('layer.settings')).k).toBe('overlay')
    expect(f.app.overlays.some(o => o.key === 'help')).toBe(false)
    expect(f.app.stores.composer.text).toBe('unsent')
    expect(f.sent('config.set').filter(p => p['key'] === 'approvals.mode')).toEqual([])
  })

  it('keeps ordinary Ctrl+C clearing and busy interruption; modified Ctrl+D does not quit', async () => {
    const f = await configured()
    await f.attach()
    await f.type('draft')
    await f.press(key('c', { ctrl: true }))
    expect(f.app.stores.composer.text).toBe('')
    expect(f.app.stores.attachments.any).toBe(false)
    const quit = vi.spyOn(f.app, 'quit')
    await f.press(key('d', { ctrl: true, alt: true }))
    expect(quit).not.toHaveBeenCalled()
    given.busy(f.app.stores, { ...busy })
    await f.press(key('c', { ctrl: true }))
    await vi.waitFor(() => expect(f.sent('session.interrupt')).toHaveLength(1))
  })

  it('opens prompt-history search with Ctrl+R without changing or submitting the draft', async () => {
    const f = await configured()
    const composer = f.app.stores.composer
    composer.set('unsent draft', { cursor: 4, pasted: ['draft'], literal: true })
    const before = { text: composer.text, cursor: composer.cursor, pasted: [...composer.pasted], revision: composer.revision }

    await f.press(key('r', { ctrl: true }))
    expect(f.app.overlays.some(o => o.key === 'prompt-history-search')).toBe(true)
    expect({ text: composer.text, cursor: composer.cursor, pasted: [...composer.pasted], revision: composer.revision }).toEqual(before)
    expect(f.sent('prompt.submit')).toEqual([])

    await f.press(key('escape'))
    expect(f.app.overlays.some(o => o.key === 'prompt-history-search')).toBe(false)
  })

  it('moves the history picker to a reconfigured chord instead of keeping Ctrl+R active', async () => {
    const f = await configured('ctrl+alt+c', { 'app.history.search': 'ctrl+alt+r' })

    await f.press(key('r', { ctrl: true }))
    expect(f.app.overlays.some(o => o.key === 'prompt-history-search')).toBe(false)

    await f.press(key('r', { ctrl: true, alt: true }))
    expect(f.app.overlays.some(o => o.key === 'prompt-history-search')).toBe(true)
    expect(f.sent('prompt.submit')).toEqual([])
  })
})

describe('configured chord validation', () => {
  it('retains twelve preexisting app actions and unchanged host reservations', () => {
    const actions = effectiveShortcuts({ 'app.thinking.cycle': 'shift+tab', 'app.message.dequeue': 'alt+up', 'app.help': 'ctrl+alt+c' })
    // This list is the app action registry, not the host-reservation list.
    expect(actions.filter(a => a.id !== 'app.history.search')).toHaveLength(12)
    expect(actions.find(a => a.id === 'app.history.search')?.keys).toEqual(['ctrl+r'])
    expect(actions).toHaveLength(13)
    expect(effectiveShortcuts({ 'app.help': 'ctrl+alt+c' }).find(a => a.id === 'app.help')?.keys).toEqual(['ctrl+alt+c'])
    for (const chord of ['ctrl+shift+c', 'ctrl+shift+v', 'ctrl+shift+p', 'ctrl+shift+k', 'meta+c']) {
      expect(() => effectiveShortcuts({ 'app.help': chord })).toThrow('Host-reserved')
    }
  })

  it('rejects fixed app, voice, retention and composer collisions before adopting a map', () => {
    for (const chord of ['alt+shift+b', 'alt+shift+f', 'alt+shift+p', 'alt+c', 'alt+shift+c', 'alt+shift+v', 'alt+shift+space', 'ctrl+alt+home']) {
      expect(() => effectiveShortcuts({ 'app.help': chord }), chord).toThrow('Fixed app key chord')
    }
    for (const chord of ['ctrl+escape', 'ctrl+enter', 'ctrl+alt+enter', 'ctrl+shift+u', 'ctrl+alt+z', 'alt+shift+d', 'ctrl+alt+backspace', 'ctrl+alt+delete', 'ctrl+up', 'ctrl+tab', 'alt+x']) {
      expect(() => effectiveShortcuts({ 'app.message.alternate': chord }), chord).toThrow('Composer-owned')
    }
  })
})
