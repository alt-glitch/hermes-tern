import { constants, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import {
  imageBytesMime,
  MEDIA_CACHE_ENTRIES,
  MEDIA_CONNECTION_BLOBS,
  type MediaPath,
  readImageBytes,
  ternSharesFrontendHost
} from '../media-delivery.js'
import { entryId } from '../core/ids.js'
import type { UserEntry } from '../model.js'
import { projectToolMedia } from '../read-media.js'
import { attachmentImagePath } from '../view/media.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { toolNode } from '../view/tools/shell.js'

import { tree } from './fakes.js'
import { png, response, setup } from './mediaDeliveryFixtures.js'
import { call } from './toolFixtures.js'

const home = mkdtempSync(join(tmpdir(), 'hermes-tern-media-'))
const image = (id = '1', host: MediaPath['host'] = 'gateway'): MediaPath => ({
  host, id, kind: 'path', mime: 'image/png', path: '/gateway/' + id + '.png',
  ...(host === 'gateway' ? { scope: 'attachment' as const } : {})
})
const toolImage = (id = '1', host: MediaPath['host'] = 'gateway'): MediaPath => ({
  host, id, kind: 'path', mime: 'image/png', path: '/gateway/' + id + '.png', toolCallId: id
})

const nodes = (value: ReturnType<typeof tree>): ReturnType<typeof tree>[] =>
  [value, ...(value.c ?? []).flatMap(nodes)]

afterEach(() => { vi.restoreAllMocks() })
afterAll(() => { rmSync(home, { recursive: true, force: true }) })

describe('bounded media bytes', () => {
  it('reads only a regular, bounded image and validates actual magic bytes', async () => {
    const file = join(home, 'image.png')
    writeFileSync(file, png)

    expect(await readImageBytes(file)).toEqual(png)
    expect(imageBytesMime(png, 'image/png; charset=binary')).toBe('image/png')
    expect(() => imageBytesMime(png, 'image/jpeg')).toThrow('mismatch')
    expect(() => imageBytesMime(Buffer.from('not an image'))).toThrow('Unsupported')
    await expect(readImageBytes(file, png.length - 1)).rejects.toThrow('regular file')
  })

  it('rejects directory reads and symlink leaf targets where O_NOFOLLOW exists', async () => {
    await expect(readImageBytes(home)).rejects.toThrow('regular file')

    if (constants.O_NOFOLLOW !== undefined) {
      const path = join(home, 'image-symlink.png')
      symlinkSync(join(home, 'image.png'), path)
      await expect(readImageBytes(path)).rejects.toThrow()
    }
  })

  it('recognizes SSH terminal/frontend host separation', () => {
    expect(ternSharesFrontendHost({})).toBe(true)
    expect(ternSharesFrontendHost({ SSH_CONNECTION: 'remote' })).toBe(false)
    expect(ternSharesFrontendHost({ SSH_TTY: 'tty' })).toBe(false)
  })
})

describe('cross-host previews', () => {
  it.each([undefined, null, '', '   '])('refuses path authority with unknown backend %s, attached or not', async backend => {
    for (const attached of [false, true]) {
      const { delivery, blob, gw } = setup({ attached, backend, native: true })
      const read = call('read_file', { path: '/gateway/same.png' }, { result: { mime: 'image/png' } })
      const card = tree(toolNode(read, 0, undefined, undefined, delivery))
      const browser = tree(toolNode(call('browser_vision', {}, {
        result: { success: true, screenshot_path: '/gateway/same.png' }
      }), 0, undefined, undefined, delivery))

      expect(delivery.context()).toMatchObject({ local: false, native: true, remoteHost: 'unknown' })
      expect(projectToolMedia(read, delivery.context())).toEqual({ kind: 'unavailable' })
      expect(JSON.stringify(card)).toContain('terminal backend identity is unknown')
      expect(nodes(card).some(n => n.k === 'image' || n.k === 'media')).toBe(false)
      expect(nodes(browser).some(n => (n.k === 'image' || n.k === 'media') && n.p?.['path'])).toBe(false)

      const entry: UserEntry = {
        at: 0, id: entryId('unknown'), kind: 'user', text: 'Attachment',
        attachments: [{ kind: 'image', name: 'same.png', refPath: '/gateway/same.png' }]
      }
      const prompt = tree(entryNode(entry, 'main.unknown', {
        copy: () => undefined, media: delivery, mediaRev: delivery.token(),
        now: 0, welcome: { version: '' }
      }))
      expect(nodes(prompt).some(n => n.k === 'image' && n.p?.['path'])).toBe(false)
      if (attached) {
        expect(JSON.stringify(prompt)).toContain('Load image preview')
        expect(attachmentImagePath('/gateway/same.png', delivery)).toMatchObject({
          host: 'gateway', scope: 'attachment'
        })
      } else {
        expect(nodes(prompt).some(n => n.p?.['role'] === 'hermes.user.attachment')).toBe(true)
        expect(attachmentImagePath('/gateway/same.png', delivery)).toBeUndefined()
      }
      expect(delivery.preview(toolImage('same', attached ? 'gateway' : 'frontend')).status).toBe('unsupported')
      await delivery.load(toolImage('same', attached ? 'gateway' : 'frontend'))
      expect(gw.sent('hermes-tern.media.image')).toEqual([])
      expect(blob).not.toHaveBeenCalled()
    }
  })

  it('renders native paths only with positive local proof, and keeps host controls distinct', () => {
    const tool = call('read_file', { path: 'same.png' })
    const known = setup({ attached: false, native: true })
    const localTree = tree(toolNode(tool, 0, undefined, undefined, known.delivery))
    expect(nodes(localTree).some(n => n.k === 'media' && n.p?.['path'] === '/gateway/same.png')).toBe(true)
    expect(known.blob).not.toHaveBeenCalled()

    for (const opts of [
      { attached: false, env: { SSH_TTY: 'ssh' }, native: true },
      { attached: true, native: true },
      { attached: false, backend: 'docker', native: true }
    ]) {
      const { delivery } = setup(opts)
      expect(delivery.context().local).toBe(false)
      const shown = tree(toolNode(tool, 0, undefined, undefined, delivery))
      expect(nodes(shown).some(n => n.k === 'media' || (n.k === 'image' && n.p?.['path']))).toBe(false)
    }
  })

  it('rebuilds read cards across unknown -> local -> gateway -> compute without fabricating tool authority', async () => {
    const { delivery, backend, blob, gw } = setup({ attached: false, backend: undefined, native: true })
    const tool = call('read_file', { path: 'same.png' })
    const render = () => tree(toolNode(tool, 0, undefined, undefined, delivery))
    const hasPath = () => nodes(render()).some(n => n.k === 'media' && n.p?.['path'] === '/gateway/same.png')

    expect(hasPath()).toBe(false)
    const unknownToken = delivery.token()
    backend('local')
    expect(hasPath()).toBe(true)
    const localToken = delivery.token()
    expect(localToken).not.toBe(unknownToken)
    backend(null)
    expect(hasPath()).toBe(false)
    backend('local')
    expect(hasPath()).toBe(true)
    expect(delivery.token()).not.toBe(localToken)

    gw.attached = true
    expect(hasPath()).toBe(false)
    expect(JSON.stringify(render())).toContain('no authenticated completed-tool evidence')
    const plan = projectToolMedia(tool, delivery.context())
    if (plan?.kind !== 'remote-image') {
      throw new Error('expected a claimed gateway read path')
    }
    await delivery.load(plan.source)
    expect(delivery.preview(plan.source).status).toBe('unsupported')
    expect(nodes(render()).some(n => n.k === 'image' && n.p?.['blob'])).toBe(false)

    backend(undefined)
    expect(JSON.stringify(render())).toContain('terminal backend identity is unknown')
    backend('local')
    expect(JSON.stringify(render())).toContain('no authenticated completed-tool evidence')
    backend('docker')
    expect(delivery.context()).toMatchObject({ local: false, remoteHost: 'compute' })
    expect(nodes(render()).some(n => n.k === 'media' || (n.k === 'image' && n.p?.['blob']))).toBe(false)
    expect(delivery.preview(plan.source).status).toBe('unsupported')
    expect(gw.sent('gateway.capabilities')).toEqual([])
    expect(gw.sent('hermes-tern.media.image')).toEqual([])
    expect(blob).not.toHaveBeenCalled()
  })

  it('drops a pending gateway upload when backend authority disappears and later returns', async () => {
    const { delivery, gw, blob, backend } = setup({ attached: true })
    const waiting = Promise.withResolvers<unknown>()
    gw.handlers.set('hermes-tern.media.image', () => waiting.promise)

    const source = image('pending')
    const pending = delivery.load(source)
    await Promise.resolve()
    backend(null)
    expect(delivery.context().remoteHost).toBe('unknown')
    backend('local')
    expect(delivery.context().remoteHost).toBe('gateway')

    waiting.resolve(response())
    await pending
    expect(blob).not.toHaveBeenCalled()
    expect(delivery.preview(source).status).toBe('available')
  })

  it('refuses a completed read_file path despite a mock RPC that would return bytes', async () => {
    const { blob, delivery, gw } = setup()
    const tool = call('read_file', { path: '/gateway/photo.png' }, { result: { mime: 'image/png' } })
    const plan = projectToolMedia(tool, delivery.context())
    expect(plan?.kind).toBe('remote-image')
    expect(JSON.stringify(tree(toolNode(tool, 0, undefined, undefined, delivery)))).toContain(
      'no authenticated completed-tool evidence'
    )
    if (plan?.kind !== 'remote-image') {
      throw new Error('expected a claimed tool image path')
    }
    expect(delivery.preview(plan.source).status).toBe('unsupported')
    await delivery.load(plan.source)
    // Spoofing an attachment scope must not turn a tool ID into a user upload.
    await delivery.load({ ...plan.source, scope: 'attachment' })
    expect(gw.sent('gateway.capabilities')).toEqual([])
    expect(gw.sent('hermes-tern.media.image')).toEqual([])
    expect(blob).not.toHaveBeenCalled()
  })

  it('keeps resumed attachment identity and requests the session-owned reference, not a guessed tool id', async () => {
    const { delivery, gw } = setup()
    const entry: UserEntry = {
      at: 0, id: entryId('u1'), kind: 'user', text: 'See attachment',
      attachments: [{ kind: 'image', name: 'archive.png', refPath: '/gateway/archive.png' }]
    }
    const view = (): TranscriptContext => ({
      copy: () => undefined,
      media: delivery, mediaRev: delivery.token(), now: 0, welcome: { version: '' }
    })

    expect(JSON.stringify(tree(entryNode(entry, 'main.u1', view())))).toContain('Load image preview')
    expect(gw.sent('hermes-tern.media.image')).toHaveLength(0)

    const path = attachmentImagePath('/gateway/archive.png', delivery)

    if (!path) {
      throw new Error('expected an authorized attachment preview path')
    }

    await delivery.load(path)
    expect(gw.sent('hermes-tern.media.image')).toEqual([{ session_id: 'session-1', path: '/gateway/archive.png' }])
    expect(nodes(tree(entryNode(entry, 'main.u1', view()))).some(n => n.k === 'image' && n.p?.['blob'] === 'tern-blob')).toBe(true)
  })

  it('refuses browser screenshot tool_call_id without an authenticated tool receipt', async () => {
    const { delivery, gw, blob } = setup()
    const tool = call('browser_vision', {}, { result: { success: true, screenshot_path: '/gateway/screenshot.png' } })
    const shown = tree(toolNode(tool, 0, undefined, undefined, delivery))
    expect(JSON.stringify(shown)).toContain('no authenticated completed-tool evidence')
    expect(nodes(shown).some(n => n.k === 'image' && n.p?.['path'])).toBe(false)

    const claimed = toolImage(String(tool.id))
    await delivery.load({ ...claimed, path: '/gateway/screenshot.png' })
    expect(gw.sent('gateway.capabilities')).toEqual([])
    expect(gw.sent('hermes-tern.media.image')).toEqual([])
    expect(blob).not.toHaveBeenCalled()
  })

  it('keeps remote image_generation paths inert without backend tool authorization', () => {
    const { delivery, gw } = setup()
    const tool = call('image_generate', { prompt: 'Sunrise' }, { result: { image: '/gateway/model.png', success: true } })
    const shown = JSON.stringify(tree(toolNode(tool, 0, undefined, undefined, delivery)))

    expect(shown).toContain('cannot authorize its file path')
    expect(gw.sent('hermes-tern.media.image')).toHaveLength(0)
  })

  it('does not offer remote previews without blob negotiation, source host, or session', async () => {
    const none = setup({ blobs: false })
    expect(none.delivery.preview(image()).status).toBe('unsupported')
    await none.delivery.load(image())
    expect(none.gw.sent('hermes-tern.media.image')).toHaveLength(0)

    const { delivery, session, blob } = setup()
    expect(delivery.preview(image('x', 'compute')).status).toBe('unsupported')
    expect(delivery.preview(image('x', 'tern')).status).toBe('unsupported')
    await delivery.load(image('x', 'compute'))
    session(null)
    expect(delivery.preview(image()).status).toBe('unsupported')
    expect(blob).not.toHaveBeenCalled()
  })

  it('never tries to load remote video/3D/PDF as the Tern host local files', () => {
    const { delivery } = setup()
    for (const path of ['a.pdf', 'a.mp4', 'a.glb']) {
      const n = tree(toolNode(call('read_file', { path }), 0, undefined, undefined, delivery))
      expect(nodes(n).some(node => node.k === 'media')).toBe(false)
      expect(JSON.stringify(n)).toContain('not host-local')
    }
  })

  it('uses bounded frontend reads for an SSH Tern, not Tern-local media paths', async () => {
    const file = join(home, 'ssh-image.png')
    writeFileSync(file, png)
    const { delivery, blob, gw } = setup({ attached: false, env: { SSH_CONNECTION: 'ssh' } })
    const tool = call('read_file', { path: file })
    const plan = projectToolMedia(tool, delivery.context())

    expect(delivery.context()).toMatchObject({ local: false, remoteHost: 'frontend' })
    expect(plan?.kind).toBe('remote-image')

    if (plan?.kind === 'remote-image') {
      await delivery.load(plan.source)
    }

    expect(blob).toHaveBeenCalledWith(png, 'image/png')
    expect(gw.sent('hermes-tern.media.image')).toHaveLength(0)
    expect(nodes(tree(toolNode(tool, 0, undefined, undefined, delivery))).some(n => n.k === 'media')).toBe(false)
  })

  it('keeps host-local media on the native path without blob transfers', () => {
    const { delivery, blob, gw } = setup({ attached: false })
    const tool = call('read_file', { path: 'a.png' })

    expect(delivery.context().local).toBe(true)
    expect(nodes(tree(toolNode(tool, 0, undefined, undefined, delivery))).some(n => n.k === 'image' && n.p?.['path'] === '/gateway/a.png')).toBe(true)
    expect(blob).not.toHaveBeenCalled()
    expect(gw.sent('hermes-tern.media.image')).toHaveLength(0)
  })

  it('reports MIME mismatch, invalid base64 and gateway failures without uploading', async () => {
    const { delivery, gw, blob } = setup()
    gw.handlers.set('hermes-tern.media.image', () => ({ ...response(), mime: 'image/jpeg' }))
    await delivery.load(image())
    expect(delivery.preview(image())).toMatchObject({ status: 'failed', error: expect.stringContaining('mismatch') })

    gw.handlers.set('hermes-tern.media.image', () => ({ ...response(), content_base64: 'not;base64' }))
    await delivery.load(image())
    expect(delivery.preview(image())).toMatchObject({ status: 'failed', error: expect.stringContaining('Invalid') })

    gw.handlers.set('hermes-tern.media.image', () => { throw new Error('access denied') })
    await delivery.load(image())
    expect(delivery.preview(image())).toMatchObject({ status: 'failed', error: 'access denied' })
    expect(blob).not.toHaveBeenCalled()
  })

  it('does not auto-retry, but retries only when requested again', async () => {
    let attempts = 0
    const { delivery, gw, blob } = setup()
    gw.handlers.set('hermes-tern.media.image', () => (++attempts === 1 ? { ...response(), bytes: 0 } : response()))

    await delivery.load(image())
    expect(delivery.preview(image()).status).toBe('failed')
    expect(gw.sent('hermes-tern.media.image')).toHaveLength(1)

    await delivery.load(image())
    expect(gw.sent('hermes-tern.media.image')).toHaveLength(2)
    expect(blob).toHaveBeenCalledOnce()
  })

  it('bounds metadata and cumulative connection blob IDs even after clear', async () => {
    const { delivery, blob } = setup()
    await delivery.load(image('0'))

    for (let i = 1; i <= MEDIA_CACHE_ENTRIES; i++) {
      await delivery.load(image(String(i)))
    }

    expect(delivery.preview(image('0')).status).toBe('available')
    expect(delivery.preview(image(String(MEDIA_CACHE_ENTRIES))).status).toBe('ready')

    for (let i = MEDIA_CACHE_ENTRIES + 1; i < MEDIA_CONNECTION_BLOBS; i++) {
      await delivery.load(image(String(i)))
    }

    delivery.clear()
    await delivery.load(image('beyond'))
    expect(delivery.preview(image('beyond')).status).toBe('exhausted')
    expect(blob).toHaveBeenCalledTimes(MEDIA_CONNECTION_BLOBS)
  })

  it('does not upload late bytes after removal, session switch or disposal', async () => {
    for (const action of ['remove', 'session', 'close']) {
      const gate = Promise.withResolvers<unknown>()
      const { delivery, blob, gw, session } = setup()
      gw.handlers.set('hermes-tern.media.image', () => gate.promise)
      const ref = image('pending')
      const pending = delivery.load(ref)
      await Promise.resolve()

      if (action === 'remove') {
        delivery.forget(ref)
      } else if (action === 'session') {
        session('another-session')
        delivery.clear()
      } else {
        delivery.clear(true)
      }

      gate.resolve(response())
      await pending
      expect(blob).not.toHaveBeenCalled()
    }
  })

  it('requires an actually advertised registered method; old Hermes never fakes a loaded blob', async () => {
    const { delivery, gw, blob } = setup()
    gw.handlers.set('gateway.capabilities', () => ({ plugin_methods: [] }))
    await delivery.load(image('old'))
    expect(delivery.preview(image('old'))).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('requires Hermes plugin gateway methods')
    })
    expect(gw.sent('hermes-tern.media.image')).toEqual([])
    expect(blob).not.toHaveBeenCalled()
  })

  it('discovers gateway image capabilities only when the user explicitly loads', async () => {
    const { delivery, gw } = setup()
    delivery.preview(image())
    delivery.token()
    expect(gw.sent('gateway.capabilities')).toEqual([])
    await delivery.load(image())
    expect(gw.sent('gateway.capabilities')).toEqual([{ session_id: 'session-1' }])
    expect(gw.sent('hermes-tern.media.image')).toHaveLength(1)
  })

  it('invalidates a gateway attachment blob when the compute backend changes', async () => {
    const { delivery, backend } = setup()
    await delivery.load(image())
    expect(delivery.preview(image()).status).toBe('ready')
    const token = delivery.token()
    backend('docker')
    expect(delivery.context().remoteHost).toBe('compute')
    expect(delivery.token()).not.toBe(token)
    // The staged gateway attachment is still eligible on compute-host changes,
    // but requires a fresh proof RPC instead of reusing the old SDK blob.
    expect(delivery.preview(image()).status).toBe('available')
  })
})


