import { EventEmitter } from 'node:events'

import { Session } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { App } from '../app/chat.js'
import { dispatched, type SlashCx } from '../commands/slash.js'
import { Composer } from '../draft/composer.js'
import { INPUT_ID } from '../surface/host.js'

import { FakeGateway, fakeTern, given, key, settle, stub, topNodes } from './fakes.js'
import { Peer } from './surfacePeer.js'

const history = vi.hoisted((): string[] => [])
vi.mock('@hermes/shared/prompt-history', () => ({
  append: (text: string) => void history.push(text),
  load: () => history
}))

describe('history and paste shell safety', () => {
  it.each([
    { original: '!echo harmless', expected: '!echo harmless' },
    { original: 'Review {!echo harmless}', expected: 'Review {!echo harmless}' }
  ])('sends recalled pasted syntax literally: $original', async ({ original, expected }) => {
    history.length = 0
    const gw = new FakeGateway({ replies: { 'shell.exec': () => ({ code: 0, stderr: '', stdout: 'stubbed' }) } })
    const tern = fakeTern({ draws: true })
    const app = new App(tern.session, gw.client, '')
    void app.run()
    given.session(app, 's1')
    const send = async (name: string, text?: string) => {
      await expect.poll(() => tern.reading).toBe(true)
      tern.press(key(name, text === undefined ? {} : { text }))
      await settle(gw)
    }
    await send('paste', original)
    await send('escape')
    await send('escape')
    await send('up')
    expect(app.stores.composer.text).toBe(original)
    expect(app.stores.composer.literal).toBe(true)
    expect(JSON.stringify(topNodes(tern.region('dock')).map(n => n.toJSON()))).toContain('Shell syntax is sent as text')
    await send('enter')
    expect(gw.sent('shell.exec')).toEqual([])
    expect(gw.sent('prompt.submit')).toEqual([expect.objectContaining({ session_id: 's1', text: expected })])
    tern.end()
  })

  it('keeps changed inline pasted syntax literal and lets freshly retyped shell run', async () => {
    history.length = 0
    const gw = new FakeGateway({ replies: { 'shell.exec': () => ({ code: 0, stderr: '', stdout: 'stubbed' }) } })
    const tern = fakeTern()
    const app = new App(tern.session, gw.client, '')
    void app.run()
    given.session(app, 's1')
    app.stores.composer.paste('Review {!echo safe}')
    app.stores.composer.splice(14, 18, 'other')
    await expect.poll(() => tern.reading).toBe(true)
    tern.press(key('enter'))
    await settle(gw)
    expect(gw.sent('shell.exec')).toEqual([])
    expect(gw.sent('prompt.submit')).toEqual([expect.objectContaining({ text: 'Review {!echo other}' })])
    app.stores.composer.set('!echo typed')
    await expect.poll(() => tern.reading).toBe(true)
    tern.press(key('enter'))
    await settle(gw)
    expect(gw.sent('shell.exec')).toEqual([{ command: 'echo typed', session_id: 's1' }])
    tern.end()
  })

  it('keeps restored app text literal after queue editing and a later edit', async () => {
    history.length = 0
    const gw = new FakeGateway()
    const tern = fakeTern()
    const app = new App(tern.session, gw.client, '')
    void app.run()
    given.session(app, 's1')
    app.stores.composer.set('new draft')
    app.stores.queue.hold({ kind: 'app', text: 'Result {!echo old}', images: [] })
    app.stores.queue.dequeue(0)
    const c = app.stores.composer
    expect(c.text).toBe('Result {!echo old}\nnew draft')
    expect(c.literal).toBe(true)
    c.splice(14, 17, 'new')
    await expect.poll(() => tern.reading).toBe(true)
    tern.press(key('enter'))
    await settle(gw)
    expect(gw.sent('shell.exec')).toEqual([])
    expect(gw.sent('prompt.submit')).toEqual([expect.objectContaining({ text: 'Result {!echo new}\nnew draft' })])
    tern.end()
  })

  it('keeps a refused app-origin send literal when restored before a newer draft', async () => {
    history.length = 0
    const submit = Promise.withResolvers<unknown>()
    const gw = new FakeGateway({ replies: { 'prompt.submit': () => submit.promise } })
    const tern = fakeTern()
    const app = new App(tern.session, gw.client, '')
    void app.run()
    given.session(app, 's1')
    app.stores.router.send({ kind: 'app', text: 'Result {!echo old}', images: [] })
    app.stores.composer.set('new draft')
    submit.reject(new Error('refused'))
    await settle(gw)
    const c = app.stores.composer
    expect(c.text).toBe('Result {!echo old}\nnew draft')
    expect(c.literal).toBe(true)
    c.splice(14, 17, 'new')
    expect(c.shellPasted).toContain(c.text)
    expect(gw.sent('shell.exec')).toEqual([])
    tern.end()
  })

  it.each([
    { draft: '/queue !echo harmless', expected: '!echo harmless' },
    { draft: '/q Review {!echo harmless}', expected: 'Review {!echo harmless}' },
    { draft: '/remotealias !echo harmless', expected: '!echo harmless' }
  ])('keeps nested queue arguments literal: $draft', async ({ draft, expected }) => {
    history.length = 0
    const gw = new FakeGateway({ replies: {
      'shell.exec': () => ({ code: 0, stderr: '', stdout: 'stubbed' }),
      'slash.exec': () => ({ type: 'alias', target: 'queue' })
    } })
    const tern = fakeTern()
    const app = new App(tern.session, gw.client, '')
    void app.run()
    given.session(app, 's1')
    app.stores.composer.paste(draft)
    await expect.poll(() => tern.reading).toBe(true)
    tern.press(key('enter'))
    await settle(gw)
    expect(gw.sent('shell.exec')).toEqual([])
    expect(gw.sent('prompt.submit')).toEqual([expect.objectContaining({ text: expected })])
    tern.end()
  })

  it('keeps fresh keyboard-typed /queue shell commands intentional', async () => {
    history.length = 0
    const gw = new FakeGateway({ replies: { 'shell.exec': () => ({ code: 0, stderr: '', stdout: 'stubbed' }) } })
    const tern = fakeTern()
    const app = new App(tern.session, gw.client, '')
    void app.run()
    given.session(app, 's1')
    for (const char of '/queue !echo typed') app.stores.composer.key(key(char, { text: char }))
    await expect.poll(() => tern.reading).toBe(true)
    tern.press(key('enter'))
    await settle(gw)
    expect(gw.sent('shell.exec')).toEqual([{ command: 'echo typed', session_id: 's1' }])
    tern.end()
  })

  it('does not grant shell authority to a gateway-supplied alias target', async () => {
    history.length = 0
    const gw = new FakeGateway({ replies: {
      'slash.exec': () => ({ type: 'alias', target: 'queue' }),
      'shell.exec': () => ({ code: 0, stderr: '', stdout: 'stubbed' })
    } })
    const tern = fakeTern()
    const app = new App(tern.session, gw.client, '')
    void app.run()
    given.session(app, 's1')
    for (const char of '/remotealias !echo typed') app.stores.composer.key(key(char, { text: char }))
    await expect.poll(() => tern.reading).toBe(true)
    tern.press(key('enter'))
    await settle(gw)
    expect(gw.sent('shell.exec')).toEqual([])
    expect(gw.sent('prompt.submit')).toEqual([expect.objectContaining({ text: '!echo typed' })])
    expect(app.transcript.entries.some(e => e.kind === 'notice' && e.text.includes('origin is unverified'))).toBe(true)
    tern.end()
  })

  it('does not execute shell syntax injected by a catalog target', async () => {
    history.length = 0
    const gw = new FakeGateway({ replies: {
      'commands.catalog': () => ({ canon: { '/remote': '/queue !echo injected' }, skills: {} }),
      'slash.exec': () => ({}),
      'shell.exec': () => ({ code: 0, stderr: '', stdout: 'stubbed' })
    } })
    const tern = fakeTern()
    const app = new App(tern.session, gw.client, '')
    void app.run()
    given.session(app, 's1')
    for (const char of '/remote') app.stores.composer.key(key(char, { text: char }))
    await expect.poll(() => tern.reading).toBe(true)
    tern.press(key('enter'))
    await settle(gw)
    expect(gw.sent('shell.exec')).toEqual([])
    expect(gw.sent('prompt.submit')).toEqual([])
    tern.end()
  })

  it('does not grant typed authority through a catalog alias to queue', async () => {
    history.length = 0
    const gw = new FakeGateway({ replies: {
      'commands.catalog': () => ({ canon: { '/remote': '/queue' }, skills: {} }),
      'shell.exec': () => ({ code: 0, stderr: '', stdout: 'stubbed' })
    } })
    const tern = fakeTern()
    const app = new App(tern.session, gw.client, '')
    void app.run()
    given.session(app, 's1')
    for (const char of '/remote !echo typed') app.stores.composer.key(key(char, { text: char }))
    await expect.poll(() => tern.reading).toBe(true)
    tern.press(key('enter'))
    await settle(gw)
    expect(gw.sent('shell.exec')).toEqual([])
    expect(gw.sent('prompt.submit')).toEqual([expect.objectContaining({ text: '!echo typed' })])
    expect(app.transcript.entries.some(e => e.kind === 'notice' && e.text.includes('origin is unverified'))).toBe(true)
    tern.end()
  })

  it('keeps literal and typed slash invocations separate while an alias reply is pending', async () => {
    history.length = 0
    const reply = Promise.withResolvers<unknown>()
    const gw = new FakeGateway({ replies: {
      'slash.exec': () => reply.promise,
      'shell.exec': () => ({ code: 0, stderr: '', stdout: 'stubbed' })
    } })
    const tern = fakeTern()
    const app = new App(tern.session, gw.client, '')
    void app.run()
    given.session(app, 's1')
    app.stores.composer.paste('/remotealias !echo pasted')
    await expect.poll(() => tern.reading).toBe(true)
    tern.press(key('enter'))
    await vi.waitFor(() => expect(gw.sent('slash.exec')).toHaveLength(1))
    for (const char of '/queue !echo typed') app.stores.composer.key(key(char, { text: char }))
    await expect.poll(() => tern.reading).toBe(true)
    tern.press(key('enter'))
    await vi.waitFor(() => expect(gw.sent('shell.exec')).toHaveLength(1))
    reply.resolve({ type: 'alias', target: 'queue' })
    await settle(gw)
    expect(gw.sent('shell.exec')).toEqual([{ command: 'echo typed', session_id: 's1' }])
    expect(gw.sent('prompt.submit')).toEqual([expect.objectContaining({ text: '!echo pasted' })])
    tern.end()
  })

  it('marks backend command prefills as origin-unknown', async () => {
    const composer = new Composer()
    await dispatched({ type: 'prefill', message: 'Review {!echo external}' }, stub<SlashCx>({ composer }), { arg: '', title: '/example' })
    expect(composer.literal).toBe(true)
    expect(composer.shellPasted).toContain(composer.text)
  })

  it('keeps literal state across an A→B→A view change', async () => {
    history.length = 0
    const gw = new FakeGateway()
    const tern = fakeTern()
    const app = new App(tern.session, gw.client, '')
    void app.run()
    given.session(app, 's1')
    app.stores.composer.paste('Review {!echo safe}')
    given.session(app, 's2')
    given.session(app, 's1')
    expect(app.stores.composer.literal).toBe(true)
    await expect.poll(() => tern.reading).toBe(true)
    tern.press(key('enter'))
    await settle(gw)
    expect(gw.sent('shell.exec')).toEqual([])
    expect(gw.sent('prompt.submit')).toEqual([expect.objectContaining({ text: 'Review {!echo safe}' })])
    tern.end()
  })

  it.each(['!echo changed', 'Review {!echo changed}'])('treats unknown native Send as literal: %s', async raw => {
    history.length = 0
    history.push('!echo old')
    const gw = new FakeGateway({ replies: { 'shell.exec': () => ({ code: 0, stderr: '', stdout: 'stubbed' }) } })
    const input = new EventEmitter()
    const peer = new Peer()
    const tern = new Session(input, { write: bytes => peer.write(bytes) }, { exitHooks: false, record: '' })
    const handshake = tern.handshake()
    input.emit('data', '\x1b_tsp;r;' + JSON.stringify({ ...tern.caps, r: 'hello', v: 1, credits: 64 }) + '\x1b\\')
    expect(await handshake).toBe(true)
    const app = new App(tern, gw.client, '')
    const running = app.run()
    try {
      given.session(app, 's1')
      app.stores.composer.key(key('up'))
      app.stores.composer.set('') // A native clear can arrive before an older Send.
      app.changed()
      await settle(gw)
      const surface = tern.surfaces[0]
      expect(surface).toBeDefined()
      const send = surface?.dispatch({ ev: 'send', id: INPUT_ID, raw: {}, sf: surface.id, text: raw })
      expect(send).toBeTypeOf('function')
      send?.()
      await settle(gw)
      expect(gw.sent('shell.exec')).toEqual([])
      expect(gw.sent('prompt.submit')).toEqual([expect.objectContaining({ text: raw })])
      expect(app.transcript.entries.some(e => e.kind === 'notice' && e.text.includes('origin is unverified'))).toBe(true)
    } finally {
      app.quit()
      await running
    }
  })

  it.each(['!echo native', 'Review {!echo native}'])('keeps native edit then Send literal: %s', async raw => {
    history.length = 0
    const gw = new FakeGateway({ replies: { 'shell.exec': () => ({ code: 0, stderr: '', stdout: 'stubbed' }) } })
    const input = new EventEmitter()
    const peer = new Peer()
    const tern = new Session(input, { write: bytes => peer.write(bytes) }, { exitHooks: false, record: '' })
    const handshake = tern.handshake()
    input.emit('data', '\x1b_tsp;r;' + JSON.stringify({ ...tern.caps, r: 'hello', v: 1, credits: 64 }) + '\x1b\\')
    expect(await handshake).toBe(true)
    const app = new App(tern, gw.client, '')
    const running = app.run()
    try {
      given.session(app, 's1')
      await settle(gw)
      const surface = tern.surfaces[0]
      expect(surface).toBeDefined()
      const edit = surface?.dispatch({ ev: 'edit', id: INPUT_ID, raw: {}, sf: surface.id, from: 0, to: 0, len: 0, cursor: raw.length, text: raw })
      expect(edit).toBeTypeOf('function')
      edit?.()
      app.changed()
      await settle(gw)
      expect(JSON.stringify(peer.frames)).toContain('Shell syntax is sent as text')
      const send = surface?.dispatch({ ev: 'send', id: INPUT_ID, raw: {}, sf: surface.id, text: raw })
      expect(send).toBeTypeOf('function')
      send?.()
      await settle(gw)
      expect(gw.sent('shell.exec')).toEqual([])
      expect(gw.sent('prompt.submit')).toEqual([expect.objectContaining({ text: raw })])
    } finally {
      app.quit()
      await running
    }
  })

  it('keeps mismatched native busy-steer input literal', async () => {
    history.length = 0
    const gw = new FakeGateway({ replies: {
      'session.resume': () => ({ execution_generation: 7 }),
      'session.steer': () => ({ status: 'queued' }),
      'shell.exec': () => ({ code: 0, stderr: '', stdout: 'stubbed' })
    } })
    const input = new EventEmitter()
    const peer = new Peer()
    const tern = new Session(input, { write: bytes => peer.write(bytes) }, { exitHooks: false, record: '' })
    const handshake = tern.handshake()
    input.emit('data', '\x1b_tsp;r;' + JSON.stringify({ ...tern.caps, r: 'hello', v: 1, credits: 64 }) + '\x1b\\')
    expect(await handshake).toBe(true)
    const app = new App(tern, gw.client, '')
    const running = app.run()
    try {
      given.session(app, 's1')
      given.busy(app.stores, { label: 'Working…', since: {}, startedAt: 0 })
      app.session.busyMode = 'steer'
      app.transcript.messageStart()
      app.changed()
      await settle(gw)
      const surface = tern.surfaces[0]
      const raw = 'Review {!echo native}'
      const send = surface?.dispatch({ ev: 'send', id: INPUT_ID, raw: {}, sf: surface.id, text: raw })
      expect(send).toBeTypeOf('function')
      send?.()
      await vi.waitFor(() => expect(gw.sent('session.steer')).toHaveLength(1))
      expect(gw.sent('shell.exec')).toEqual([])
      expect(gw.sent('session.steer')[0]).toMatchObject({ text: raw })
      expect(app.transcript.entries.some(e => e.kind === 'notice' && e.text.includes('origin is unverified'))).toBe(true)
    } finally {
      app.quit()
      await running
    }
  })
})
