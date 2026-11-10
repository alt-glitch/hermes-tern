import { node, Surface, View, ViewError } from '@stencil-hq/tern'
import type { SessionInfo } from '@hermes/shared/gateway-types'
import { describe, expect, it, vi } from 'vitest'

import { liveSessionId } from '../../core/ids.js'
import { openHelp, type HelpHost } from '../../overlays/help.js'
import type { Overlay } from '../../overlays/overlay.js'
import { SessionState } from '../../session/state.js'
import { Transcript } from '../../transcript/store.js'
import { FakeGateway, stub } from '../../__tests__/fakes.js'

import { BindingPreferences } from '../binding-preferences.js'

function fixture() {
  const gw = new FakeGateway()
  const session = new SessionState(() => {})
  session.ref = { live: liveSessionId('s1'), stored: null }
  session.info = stub<SessionInfo>({ profile_name: 'a' })
  const overlays: Overlay[] = []
  const close = vi.fn()
  const host: HelpHost = {
    gw: gw.client,
    session,
    transcript: new Transcript(),
    open: overlay => { overlays.push(overlay) },
    close
  }
  const preferences = new BindingPreferences({
    gw: gw.client,
    session,
    changed: vi.fn(),
    notice: vi.fn()
  })
  const owner = () => ({ ref: session.ref, sid: session.ref.live ?? '', profile: session.info?.profile_name ?? '' })
  return { gw, host, overlays, close, preferences, session, owner }
}

/** Exercise actual SDK Surface.render -> View.from -> Tree validation. */
function rendered(overlay: Overlay): View {
  const layer = [overlay.node('layer.overlay-1')]
  const send = vi.fn()
  const surface = new Surface({ send, credits: () => 1, dropped: () => {} }, 'hermes', { mode: 'inline' })
  surface.render({ layer })
  expect(send).toHaveBeenCalledOnce()
  return View.from({ layer })
}

function top(overlays: Overlay[]): Overlay {
  const found = overlays.at(-1)
  if (!found) throw new Error('Help overlay not opened')
  return found
}

function rows(view: View, id: string): string {
  const items = view.find('layer.overlay-1.body.' + id + '.table')?.props['rows']
  if (!Array.isArray(items)) throw new Error('Missing Help table ' + id)
  return JSON.stringify(items)
}

describe('native Help tree validation', () => {
  it('renders defaults through real Surface with one Control group and reachable labels', async () => {
    const f = fixture()
    await openHelp(f.host)
    expect(f.gw.sent('commands.catalog')).toEqual([{ session_id: 's1' }])
    const view = rendered(top(f.overlays))
    const groups = view.find('layer.overlay-1.body')?.children
      .filter(item => item.kind === 'section')
      .map(item => item.props['head'])
    expect(groups).toEqual(['Editing', 'Control', 'Navigation', 'Models', 'Tern'])
    const control = rows(view, 'keys-Control')
    expect(control).toContain('Cycle reasoning effort')
    expect(control.match(/Cycle reasoning effort/g)).toHaveLength(1)
    expect(control).toContain('shift+tab')
    expect(control).toContain('ctrl+v')
    expect(control).toContain('ctrl+c')
    expect(control).toContain('ctrl+d')
    expect(rows(view, 'keys-Navigation')).toContain('alt+k')
    expect(rows(view, 'keys-Models')).toContain('ctrl+alt+p')
    expect(rows(view, 'keys-Models')).not.toContain('ctrl+shift+p')
  })

  it('uses adopted profile chords without stale static defaults or missing safety controls', async () => {
    const f = fixture()
    const accepted = f.preferences.accept({
      config: { display: { tern_keybindings: {
        'app.help': 'alt+h',
        'app.thinking.cycle': 'ctrl+alt+e',
        'app.message.dequeue': 'ctrl+alt+u',
        'app.model.cycleBackward': 'alt+z',
        'app.palette': 'ctrl+alt+k'
      }, tern_profile_identity: true } }
    }, f.owner(), { display: 'Work' })
    expect(accepted).toBe(true)
    expect(f.preferences.profile).toBe('Work')
    await openHelp(f.host, f.preferences.actions)
    const view = rendered(top(f.overlays))
    const control = rows(view, 'keys-Control')
    const navigation = rows(view, 'keys-Navigation')
    const models = rows(view, 'keys-Models')
    expect(control).toContain('ctrl+alt+e')
    expect(control).toContain('ctrl+alt+u')
    expect(control).not.toContain('shift+tab')
    expect(control).not.toContain('alt+up')
    expect(control).toContain('ctrl+c')
    expect(control).toContain('ctrl+d')
    expect(navigation).toContain('alt+h')
    expect(navigation).toContain('ctrl+alt+k')
    expect(navigation).not.toContain('"t":"alt+k"')
    expect(models).toContain('alt+z')
    expect(models).not.toContain('ctrl+alt+p')
    const overlay = top(f.overlays)
    overlay.onKey({ name: 'escape', ctrl: false, alt: false, meta: false, shift: false })
    expect(f.close).toHaveBeenCalledWith(overlay)
  })

  it('merges duplicate backend headings and command rows before SDK validation', async () => {
    const f = fixture()
    f.gw.handlers.set('commands.catalog', () => ({
      categories: [
        { name: 'Commands', pairs: [['/foo', 'First'], ['/foo', 'Duplicate']] },
        { name: 'Commands', pairs: [['/bar', 'Second']] },
        { name: 'Tern', pairs: [['/extra', 'Backend command']] }
      ]
    }))
    await openHelp(f.host)
    const view = rendered(top(f.overlays))
    const headings = view.find('layer.overlay-1.body')?.children
      .filter(item => item.kind === 'section')
      .map(item => item.props['head'])
    expect(headings?.filter(x => x === 'Tern')).toHaveLength(1)
    expect(headings?.filter(x => x === 'Commands')).toHaveLength(1)
    const commands = rows(view, 'cmd-Commands')
    expect(commands).toContain('/bar')
    expect(commands.split('/foo').length - 1).toBe(1)
    expect(rows(view, 'cmd-Tern')).toContain('/extra')
  })

  it('renders built-in SDK Help for a replaced owner even when sid is reused', async () => {
    const f = fixture()
    expect(f.preferences.accept({
      config: { display: { tern_keybindings: { 'app.help': 'alt+h' }, tern_profile_identity: true } }
    }, f.owner(), { display: 'Old pretty name' })).toBe(true)
    f.session.ref = { live: liveSessionId('s1'), stored: null }
    f.session.info = stub<SessionInfo>({ profile_name: 'b' })
    expect(f.preferences.profile).toBe('')
    await openHelp(f.host, f.preferences.actions)
    const navigation = rows(rendered(top(f.overlays)), 'keys-Navigation')
    expect(navigation).toContain('f1')
    expect(navigation).toContain('alt+k')
    expect(navigation).not.toContain('alt+h')
  })

  it('proves the SDK validation would reject the original duplicate key', () => {
    const broken = node('overlay', { key: 'help' }, node('col', { key: 'body' }, [
      node('section', { key: 'keys-Control' }),
      node('section', { key: 'keys-Control' })
    ]))
    const surface = new Surface({ send: vi.fn(), credits: () => 1, dropped: () => {} }, 'hermes', {})
    expect(() => surface.render({ layer: [broken] })).toThrow(ViewError)
  })
})
