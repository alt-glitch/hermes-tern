import { EventEmitter } from 'node:events'
import { Session, Surface } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'
import { FakeGateway, given } from './fakes.js'
import { App } from './appSetup.js'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))
vi.mock('../../assets/logo.png', async () => {
  const { readFile } = await import('node:fs/promises')
  return { default: await readFile(new URL('../../assets/logo.png', import.meta.url)) }
})

describe('Ctrl+L through a connected native SDK session', () => {
  it('decodes the real chord, paints a listening orb, and hangs up with another chord', async () => {
    delete process.env['HERMES_TUI_SPLASH']
    delete process.env['HERMES_TUI_QUERY']
    delete process.env['HERMES_TUI_IMAGE']
    const input = new EventEmitter()
    const tern = new Session(input, { write() {} }, { exitHooks: false, record: '' })
    const connecting = tern.handshake()
    input.emit('data', `\x1b_tsp;r;${JSON.stringify({ ...tern.caps, r: 'hello', v: 1, term: 'fixture', ver: '0', features: ['blobs'], credits: 64, apc: 1048576 })}\x1b\\`)
    expect(await connecting).toBe(true)
    let active = false
    const gateway = new FakeGateway({ canonical: true, replies: { 'command.dispatch': p => {
      const [action, id] = String(p['arg']).split(' ')
      if (action === 'start') active = true
      if (action === 'stop') active = false
      return { type: 'plugin', output: JSON.stringify({ live_id: id, phase: active ? 'listening' : 'idle', active, error: '' }) }
    } } })
    const renders = vi.spyOn(Surface.prototype, 'render')
    const app = new App(tern, gateway.client, '1.0.0')
    const running = app.run()
    given.session(app, 's1')
    app.stores.composer.set('native draft', { cursor: 3 })
    try {
      await vi.waitFor(() => expect(renders).toHaveBeenCalled())
      input.emit('data', '\x1b[108;5u')
      await vi.waitFor(() => expect(app.liveVoice.phase).toBe('listening'))
      await vi.waitFor(() => expect(JSON.stringify(renders.mock.calls.at(-1))).toContain('Hermes agent: listening'))
      expect(app.stores.composer.text).toBe('native draft')
      expect(app.stores.composer.cursor).toBe(3)
      input.emit('data', '\x0c')
      await vi.waitFor(() => expect(app.liveVoice.blocked).toBe(false))
      expect(gateway.sent('command.dispatch').map(p => String(p['arg']).split(' ')[0]).filter(action => action !== 'status')).toEqual(['start', 'stop'])
      expect(gateway.sent('prompt.submit')).toHaveLength(0)
    } finally {
      app.quit()
      await running
      tern.close()
      renders.mockRestore()
    }
  })
})
