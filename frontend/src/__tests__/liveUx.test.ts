import { Node } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { INPUT_ID } from '../surface/host.js'
import { App, png } from './appSetup.js'
import { FakeGateway, fakeTern, given, key, settle, stubOverlay, topNodes } from './fakes.js'

vi.mock('@hermes/shared/prompt-history', () => ({ append: () => undefined, load: () => [] }))

/** The actual dock tree, not a mock copy of the orb model. */
function flattened(items: Node[]): Node[] {
  return items.flatMap(n => [n, ...flattened(n.children.filter((child): child is Node => child instanceof Node))])
}

/** Use the real editor's registered SDK handler: native Send is not a keyboard event. */
function nativeSend(tern: ReturnType<typeof fakeTern>, text: string) {
  const editor = flattened(topNodes(tern.region('dock'))).find(n => typeof n.handlers?.onSend === 'function')
  const send = editor?.handlers?.onSend

  if (typeof send !== 'function') {
    throw new Error('native editor Send handler is missing')
  }

  send({ ev: 'send', sf: 'hermes', id: INPUT_ID, text, raw: {} })
}

describe('the visible live UX in App', () => {
  it('paints an agent orb for its own session and ignores foreign events', async () => {
    const gw = new FakeGateway()
    const tern = fakeTern({ draws: true, features: ['blobs'] })
    const app = new App(tern.session, gw.client, '1.0')
    void app.run()
    given.session(app.stores, 's1')

    const orb = () => flattened(topNodes(tern.region('dock'))).find(n => n.props['role'] === 'hermes.agent.orb')

    try {
      await settle(gw)
      expect(orb()?.props['alt']).toBe('Hermes agent: idle')

      gw.event({ type: 'message.start', session_id: 'foreign', payload: {} })
      await settle(gw)
      expect(orb()?.props['alt']).toBe('Hermes agent: idle')

      gw.event({ type: 'message.start', session_id: 's1', payload: {} })
      gw.event({ type: 'reasoning.delta', session_id: 's1', payload: { text: 'reasoning' } })
      await settle(gw)
      expect(orb()?.props['alt']).toBe('Hermes agent: thinking')

      gw.event({ type: 'message.complete', session_id: 's1', payload: { status: 'complete' } })
      await settle(gw)
      expect(orb()?.props['alt']).toBe('Hermes agent: idle')
    } finally {
      app.dispose()
      tern.end()
    }
  })

  it('does not paint hidden frames and delivers completion attention on return', async () => {
    const gw = new FakeGateway()
    const tern = fakeTern({ draws: true, features: ['blobs'] })
    const app = new App(tern.session, gw.client, '1.0')
    void app.run()
    given.session(app.stores, 's1')

    try {
      await settle(gw)
      tern.send({ ev: 'visible', sf: 'hermes', raw: {}, visible: false })
      await settle(gw)
      const before = tern.frame
      gw.event({ type: 'message.start', session_id: 's1', payload: {} })
      gw.event({ type: 'message.complete', session_id: 's1', payload: { status: 'complete' } })
      await settle(gw)

      expect(tern.frame).toBe(before)
      expect(app.stores.notices.current()).toBeUndefined()

      const finished = 'A Hermes turn finished while this pane was hidden.'
      const dockNotice = () => flattened(topNodes(tern.region('dock'))).find(n => n.props['title'] === finished)
      expect(dockNotice()).toBeUndefined()

      tern.send({ ev: 'visible', sf: 'hermes', raw: {}, visible: true })
      await vi.waitFor(() => {
        expect(tern.frame).not.toBe(before)
        expect(dockNotice()?.props['spans']).toEqual([{ t: finished }])
      })
      expect(app.stores.notices.current()?.text).toBe(finished)
    } finally {
      app.dispose()
      tern.end()
    }
  })

  it('blocks native Send behind a modal without leaking hidden prompt text or changing caret', async () => {
    const gw = new FakeGateway({ replies: { 'session.resume': () => ({ execution_generation: 7 }), 'session.steer': () => ({ status: 'queued' }) } })
    const tern = fakeTern({ draws: true, features: ['blobs'] })
    const app = new App(tern.session, gw.client, '1.0')
    void app.run()
    given.session(app.stores, 's1')

    try {
      app.stores.composer.set('hidden text', { cursor: 3 })
      const modal = stubOverlay('prompt:consent', { modal: true })
      app.open(modal)
      await settle(gw)
      const editor = flattened(topNodes(tern.region('dock'))).find(n => typeof n.handlers?.onSend === 'function')
      expect(editor?.props['sendable']).toBe(false)
      nativeSend(tern, 'hidden text')
      await settle(gw)

      expect(gw.sent('prompt.submit')).toEqual([])
      expect(gw.sent('session.steer')).toEqual([])
      expect(app.stores.composer.text).toBe('hidden text')
      expect(app.stores.composer.cursor).toBe(3)

      given.busy(app.stores, { label: 'Working…', since: {}, startedAt: 0 })
      app.session.busyMode = 'steer'
      app.changed()
      await settle(gw)
      nativeSend(tern, 'hidden busy correction')
      await settle(gw)

      expect(gw.sent('prompt.submit')).toEqual([])
      expect(gw.sent('session.steer')).toEqual([])
      expect(app.stores.composer.text).toBe('hidden text')
      expect(app.stores.composer.cursor).toBe(3)
    } finally {
      app.dispose()
      tern.end()
    }
  })

  it('withholds native readiness during image upload, while keyboard slash commands remain usable', async () => {
    const upload = Promise.withResolvers<unknown>()
    const gw = new FakeGateway({ replies: { 'image.attach_bytes': () => upload.promise } })
    const tern = fakeTern({ draws: true })
    const app = new App(tern.session, gw.client, '1.0')
    void app.run()
    given.session(app.stores, 's1')
    const editor = () => flattened(topNodes(tern.region('dock'))).find(n => typeof n.handlers?.onSend === 'function')

    try {
      const attaching = app.stores.attachments.fromPath(png)
      await vi.waitFor(() => expect(app.stores.attachments.uploading).toBe(true))
      await settle(gw)
      expect(editor()?.props['sendable']).toBe(false)
      nativeSend(tern, 'wait for image')
      expect(gw.sent('prompt.submit')).toEqual([])
      expect(app.stores.composer.text).toBe('wait for image')
      expect(app.transcript.entries.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('still attaching') })

      app.stores.composer.set('/palette')
      app.changed()
      await settle(gw)
      await vi.waitFor(() => expect(tern.reading).toBe(true))
      tern.press(key('enter'))
      await vi.waitFor(() => expect(app.overlays.at(-1)?.key).toBe('command-palette'))
      expect(app.stores.attachments.uploading).toBe(true)
      upload.resolve({ path: '/uploads/slow.png' })
      await attaching
      const palette = app.overlays.at(-1)
      if (palette) { app.close(palette) }
      await settle(gw)
      expect(editor()?.props['sendable']).toBe(true)
    } finally {
      upload.resolve({ path: '/uploads/slow.png' })
      app.dispose()
      tern.end()
    }
  })

  it('native Send expands typed inline corrections and preserves pasted exclusions', async () => {
    const gw = new FakeGateway({
      replies: {
        'session.resume': () => ({ execution_generation: 7 }),
        'session.steer': () => ({ status: 'queued' }),
        'shell.exec': () => ({ code: 0, stderr: '', stdout: 'branch-main' })
      }
    })
    const tern = fakeTern({ draws: true })
    const app = new App(tern.session, gw.client, '1.0')
    void app.run()
    given.session(app.stores, 's1')
    given.busy(app.stores, { label: 'Working…', since: {}, startedAt: 0 })
    app.session.busyMode = 'steer'
    app.transcript.messageStart()

    try {
      const raw = 'Review {!git branch --show-current}'
      app.stores.composer.set(raw)
      app.changed()
      await settle(gw)
      nativeSend(tern, raw)
      await vi.waitFor(() => expect(gw.sent('session.steer')).toHaveLength(1))
      expect(gw.sent('shell.exec')).toEqual([{ command: 'git branch --show-current', session_id: 's1' }])
      expect(gw.sent('session.steer')[0]).toMatchObject({ text: 'Review branch-main' })

      app.stores.composer.key(key('paste', { text: raw }))
      app.changed()
      await settle(gw)
      nativeSend(tern, raw)
      await vi.waitFor(() => expect(gw.sent('session.steer')).toHaveLength(2))
      expect(gw.sent('shell.exec')).toHaveLength(1)
      expect(gw.sent('session.steer')[1]).toMatchObject({ text: raw })
      expect(gw.sent('prompt.submit')).toEqual([])
    } finally {
      app.dispose()
      tern.end()
    }
  })

  it('keeps the orb idle during shell expansion and pending submit until message.start', async () => {
    const shell = Promise.withResolvers<{ code: number; stderr: string; stdout: string }>()
    const admission = Promise.withResolvers<object>()
    const gw = new FakeGateway({ replies: { 'shell.exec': () => shell.promise, 'prompt.submit': () => admission.promise } })
    const tern = fakeTern({ draws: true, features: ['blobs'] })
    const app = new App(tern.session, gw.client, '1.0')
    void app.run()
    given.session(app.stores, 's1')

    const orb = () => flattened(topNodes(tern.region('dock'))).find(n => n.props['role'] === 'hermes.agent.orb')

    try {
      await settle(gw)
      expect(orb()?.props['alt']).toBe('Hermes agent: idle')
      app.stores.composer.set('Review {!git status}')
      app.changed()
      await settle(gw)
      await vi.waitFor(() => expect(tern.reading).toBe(true))
      tern.press(key('enter'))
      await vi.waitFor(() => expect(gw.sent('shell.exec')).toHaveLength(1))
      await settle(gw)

      expect(app.busy).not.toBeNull()
      expect(orb()?.props['alt']).toBe('Hermes agent: idle')

      shell.resolve({ code: 0, stderr: '', stdout: 'clean' })
      await vi.waitFor(() => expect(gw.sent('prompt.submit')).toHaveLength(1))
      await settle(gw)
      expect(orb()?.props['alt']).toBe('Hermes agent: idle')

      gw.event({ type: 'message.start', session_id: 's1', payload: {} })
      await settle(gw)
      expect(orb()?.props['alt']).toBe('Hermes agent: working')
      admission.resolve({ status: 'queued' })
    } finally {
      app.dispose()
      tern.end()
    }
  })
})
