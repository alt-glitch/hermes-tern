import { type JSX, Node } from '@stencil-hq/tern'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { localCommand } from '../commands/local.js'
import { dockModel } from '../view/dockModel.js'
import { settle, setup } from './appSetup.js'
import { given, key } from './fakes.js'

vi.mock('@hermes/shared/prompt-history', () => ({ append: () => undefined, load: () => [] }))

beforeEach(() => {
  delete process.env['HERMES_TERN_QUERY']
  delete process.env['HERMES_TERN_IMAGE']
  delete process.env['HERMES_TUI_SPLASH']
})
const disposals: (() => void)[] = []
afterEach(() => { for (const dispose of disposals.splice(0)) dispose() })

const toggle = key('v', { alt: true, shift: true })
const quick = key('l', { ctrl: true })
function fixture() {
  let phase = 'listening', active = false, error = ''
  const f = setup({ 'command.dispatch': p => {
    const [action, id] = String(p['arg']).split(' ')
    if (p['name'] !== 'tern-talk') throw new Error('unexpected command')
    if (action === 'start') active = true
    if (action === 'stop') active = false
    return { type: 'plugin', output: JSON.stringify({ live_id: id, phase: active ? phase : 'idle', active, error }) }
  } })
  disposals.push(() => f.app.stores.talkGateway.dispose())
  return { ...f, calls: () => f.sent('command.dispatch').filter(p => p['name'] === 'tern-talk'),
    setPhase: (value: string) => { phase = value }, fail: (value: string) => { error = value; active = false } }
}
function clickRole(root: JSX.Element | null, role: string): void {
  const walk = (node: JSX.Element): Node[] => node instanceof Node ? [node, ...node.children.flatMap(walk)] : []
  const control = root ? walk(root).find(node => node.props['role'] === role) : undefined
  if (!control) throw new Error('Missing control ' + role)
  control.handlers?.onClick?.({ act: 'click', ev: 'action', id: 'x', raw: {}, sf: 'hermes' })
}

describe('Hermes Talk through the app input loop', () => {
  it('Ctrl+L starts and stops one actual adapter lease without sending or clearing a draft', async () => {
    const f = fixture()
    f.app.stores.composer.set('keep this draft', { cursor: 4 })
    await f.press(quick)
    await settle()
    expect(f.calls().filter(p => String(p['arg']).startsWith('start '))).toHaveLength(1)
    expect(f.app.liveVoice.phase).toBe('listening')
    expect(f.app.liveVoice.blocked).toBe(true)
    await f.press(quick)
    await settle()
    expect(f.calls().filter(p => String(p['arg']).startsWith('stop '))).toHaveLength(1)
    expect(f.app.liveVoice.blocked).toBe(false)
    expect(f.app.stores.composer.text).toBe('keep this draft')
    expect(f.app.stores.composer.cursor).toBe(4)
    expect(f.sent('prompt.submit')).toHaveLength(0)
    expect(f.sent('voice.live.start')).toHaveLength(0)
  })

  it('Alt+Shift+V retains its disclosure and Allow; consent itself opens no audio', async () => {
    const f = fixture()
    await f.press(toggle)
    expect(f.app.liveVoice.phase).toBe('consent')
    expect(f.calls()).toHaveLength(0)
    clickRole(f.app.liveVoice.node(), 'omp.live.start')
    await settle()
    expect(f.app.liveVoice.phase).toBe('listening')
    expect(f.calls().filter(p => String(p['arg']).startsWith('start '))).toHaveLength(1)
    expect(dockModel(f.app.stores, 0).composer.ready).toBe(false)
  })

  it('Escape and native Stop release the owned call, not the typed draft', async () => {
    const f = fixture()
    f.app.stores.composer.set('unsent')
    await f.press(quick)
    await f.press(key('escape'))
    await settle()
    expect(f.app.liveVoice.blocked).toBe(false)
    await f.press(quick)
    clickRole(f.app.liveVoice.node(), 'omp.live.stop')
    await settle()
    expect(f.app.liveVoice.blocked).toBe(false)
    expect(f.app.stores.composer.text).toBe('unsent')
    expect(f.sent('session.interrupt')).toHaveLength(0)
  })

  it('does not expose unsupported mute/interrupt controls on the Talk adapter', async () => {
    const f = fixture()
    await f.press(quick)
    expect(() => clickRole(f.app.liveVoice.node(), 'omp.live.mute')).toThrow('Missing control')
    expect(() => clickRole(f.app.liveVoice.node(), 'omp.live.interrupt')).toThrow('Missing control')
  })

  it('retires audio on session change without moving a call into the new conversation', async () => {
    const f = fixture()
    await f.press(quick)
    given.session(f.app.stores, 's2')
    f.app.changed()
    await settle()
    expect(f.calls().at(-1)).toMatchObject({ session_id: 's1' })
    expect(String(f.calls().at(-1)?.['arg'])).toMatch(/^stop /)
    expect(f.app.liveVoice.blocked).toBe(false)
  })

  it('provider phases update the real emitted orb rather than guessing from typed turns', async () => {
    const f = fixture()
    await f.press(quick)
    expect(f.app.liveVoice.phase).toBe('listening')
    f.setPhase('speaking')
    await vi.waitFor(() => expect(f.app.liveVoice.phase).toBe('speaking'), { timeout: 1500 })
    f.setPhase('thinking')
    await vi.waitFor(() => expect(f.app.liveVoice.phase).toBe('thinking'), { timeout: 1500 })
    await f.press(quick)
    expect(f.app.liveVoice.phase).toBe('idle')
  })

  it('a terminal error releases input, stays visible, and never starts another call automatically', async () => {
    const f = fixture()
    await f.press(quick)
    f.fail('Hermes Talk refused startup: audio')
    await vi.waitFor(() => expect(f.app.liveVoice.blocked).toBe(false), { timeout: 1500 })
    expect(f.app.liveVoice.error).toContain('audio')
    expect(f.calls().filter(p => String(p['arg']).startsWith('start '))).toHaveLength(1)
  })

  it('/live off revokes disclosure and backend exit clears the local lease', async () => {
    const f = fixture()
    await localCommand('live')?.run(f.app, '')
    expect(f.app.liveVoice.phase).toBe('consent')
    await localCommand('live')?.run(f.app, 'off')
    expect(f.calls()).toHaveLength(0)
    await f.press(quick)
    f.emit('exit', 1)
    await settle()
    expect(f.app.liveVoice.blocked).toBe(false)
  })
})
