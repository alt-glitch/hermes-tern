import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MediaDelivery, MediaPath } from '../media-delivery.js'
import { entryId } from '../core/ids.js'
import type { UserEntry } from '../model.js'
import { projectToolMedia } from '../read-media.js'
import { attachmentImagePath } from '../view/media.js'
import { entryNode } from '../view/transcript.js'

import { tree } from './fakes.js'
import { png, response, setup } from './mediaDeliveryFixtures.js'
import { call } from './toolFixtures.js'

const nodes = (value: ReturnType<typeof tree>): ReturnType<typeof tree>[] =>
  [value, ...(value.c ?? []).flatMap(nodes)]

afterEach(() => { vi.restoreAllMocks() })
describe('gateway-owned prompt attachments with absent terminal_backend', () => {
  const attachedImage = '/gateway/owned.png'
  const entry: UserEntry = {
    at: 0, id: entryId('owned-upload'), kind: 'user', text: 'Please inspect the image',
    attachments: [{ kind: 'image', name: 'owned.png', refPath: attachedImage }]
  }

  function draw(delivery: MediaDelivery) {
    return tree(entryNode(entry, 'main.owned-upload', {
      copy: () => undefined, media: delivery, mediaRev: delivery.token(),
      now: 0, welcome: { version: '' }
    }))
  }

  it('shows no Load or Retry while disconnected and never reuses blobs across reconnects', async () => {
    const { delivery, gw, blob } = setup({ attached: false, backend: undefined, native: true })
    const source: MediaPath = { kind: 'path', host: 'gateway', path: attachedImage, id: attachedImage, scope: 'attachment' }
    expect(attachmentImagePath(attachedImage, delivery)).toBeUndefined()
    expect(delivery.preview(source)).toEqual({ status: 'unsupported', label: 'Image path does not belong to the active host.' })
    expect(JSON.stringify(draw(delivery))).not.toMatch(/Load image preview|Retry preview/)
    await delivery.load(source)
    expect(gw.sent('gateway.capabilities')).toEqual([])
    expect(gw.sent('hermes-tern.media.image')).toEqual([])
    expect(blob).not.toHaveBeenCalled()

    // Reattaching permits an explicit load; disconnecting revokes its blob.
    gw.attached = true
    expect(delivery.preview(source).status).toBe('available')
    await delivery.load(source)
    expect(delivery.preview(source).status).toBe('ready')
    expect(blob).toHaveBeenCalledOnce()
    gw.attached = false
    expect(delivery.preview(source).status).toBe('unsupported')
    expect(JSON.stringify(draw(delivery))).not.toMatch(/Load image preview|Retry preview/)
    await delivery.load(source)
    expect(gw.sent('hermes-tern.media.image')).toHaveLength(1)
    gw.attached = true
    expect(delivery.preview(source).status).toBe('available')
    await delivery.load(source)
    expect(gw.sent('hermes-tern.media.image')).toHaveLength(2)
    expect(blob).toHaveBeenCalledTimes(2)
  })

  it.each(['unadvertised', 'discovery error'])('a gateway capability %s never fetches image bytes or uploads a blob', async mode => {
    const { delivery, gw, blob } = setup({ backend: undefined, native: true })
    const source = attachmentImagePath(attachedImage, delivery)
    if (!source) throw new Error('missing gateway attachment source')
    gw.handlers.set('gateway.capabilities', () => {
      if (mode === 'discovery error') throw new Error('gateway capability discovery failed')
      return { plugin_methods: [] }
    })

    expect(delivery.preview(source).status).toBe('available')
    await delivery.load(source)

    expect(gw.sent('gateway.capabilities')).toEqual([{ session_id: 'session-1' }])
    expect(gw.sent('hermes-tern.media.image')).toEqual([])
    expect(delivery.preview(source)).toMatchObject({
      status: 'failed', error: mode === 'discovery error'
        ? 'gateway capability discovery failed'
        : 'Image preview requires Hermes plugin gateway methods; upgrade Hermes and enable hermes-tern.'
    })
    expect(blob).not.toHaveBeenCalled()
    expect(nodes(draw(delivery)).some(n => n.k === 'image' && n.p?.['blob'])).toBe(false)
  })

  it('a gateway owner refusal cannot reuse a previous session blob or grant path authority', async () => {
    const { delivery, gw, session, blob } = setup({ backend: undefined })
    const source = attachmentImagePath(attachedImage, delivery)
    if (!source) throw new Error('missing gateway attachment source')
    await delivery.load(source)
    expect(delivery.preview(source).status).toBe('ready')
    expect(blob).toHaveBeenCalledOnce()
    session('not-owner')
    gw.handlers.set('hermes-tern.media.image', () => { throw new Error('attachment_not_owned') })
    expect(delivery.preview(source).status).toBe('available')
    await delivery.load(source)

    expect(gw.sent('hermes-tern.media.image').at(-1)).toEqual({ session_id: 'not-owner', path: attachedImage })
    expect(delivery.preview(source)).toMatchObject({ status: 'failed', error: 'attachment_not_owned' })
    expect(blob).toHaveBeenCalledOnce()
    expect(nodes(draw(delivery)).some(n => n.k === 'image' && n.p?.['blob'])).toBe(false)
    session('session-1')
    gw.handlers.set('hermes-tern.media.image', response)
    expect(delivery.preview(source).status).toBe('available')
    await delivery.load(source)
    expect(blob).toHaveBeenCalledTimes(2)
    expect(gw.sent('hermes-tern.media.image')).toHaveLength(3)
  })

  it('routes only canonical committed native-input paths to the explicit backend proof', async () => {
    const { delivery, gw, blob } = setup({ attached: true, backend: undefined, native: true })
    const committed = '/profile/cache/documents/native-inputs/' + 'a'.repeat(64) + '/tern_upload_abcd1234.png'
    const source = attachmentImagePath(committed, delivery)
    expect(source).toMatchObject({ path: committed, host: 'gateway', scope: 'attachment' })
    if (!source) {
      throw new Error('missing committed attachment route')
    }
    expect(delivery.preview(source).status).toBe('available')
    expect(gw.sent('gateway.capabilities')).toEqual([])
    await delivery.load(source)
    expect(gw.sent('hermes-tern.media.image')).toEqual([{ session_id: 'session-1', path: committed }])
    expect(blob).toHaveBeenCalledWith(png, 'image/png')

    // A gateway-side negative receipt is a refusal, not a fallback path read.
    const bad = attachmentImagePath('/profile/cache/images/typed.png', delivery)
    if (!bad) {
      throw new Error('missing negative-control attachment route')
    }
    gw.handlers.set('hermes-tern.media.image', () => { throw new Error('Image is not an owned completed canonical attachment') })
    await delivery.load(bad)
    expect(delivery.preview(bad)).toMatchObject({
      status: 'failed', error: 'Image is not an owned completed canonical attachment'
    })
    expect(blob).toHaveBeenCalledOnce()
  })

  it('projects real attachmentImagePath to a visible Load, registered byte RPC, then Session.blob', async () => {
    const { delivery, gw, blob } = setup({ backend: undefined, attached: true, native: true })
    expect(delivery.context().remoteHost).toBe('unknown')
    const source = attachmentImagePath(attachedImage, delivery)
    expect(source).toMatchObject({ host: 'gateway', path: attachedImage, scope: 'attachment' })
    if (!source) {
      throw new Error('attached gateway path was not projected')
    }
    expect(JSON.stringify(draw(delivery))).toContain('Load image preview')
    expect(gw.sent('gateway.capabilities')).toEqual([])
    expect(gw.sent('hermes-tern.media.image')).toEqual([])
    await delivery.load(source) // same explicit action the visible Load control wires
    expect(gw.sent('gateway.capabilities')).toEqual([{ session_id: 'session-1' }])
    expect(gw.sent('hermes-tern.media.image')).toEqual([
      { session_id: 'session-1', path: attachedImage }
    ])
    expect(blob).toHaveBeenCalledOnce()
    expect(blob).toHaveBeenCalledWith(png, 'image/png')
    expect(nodes(draw(delivery)).some(n => n.k === 'image' && n.p?.['blob'] === 'tern-blob')).toBe(true)
    expect(delivery.preview(source)).toEqual({ status: 'ready', blob: 'tern-blob' })
    expect(projectToolMedia(call('read_file', { path: attachedImage }), delivery.context())).toEqual({
      kind: 'unavailable'
    })
  })

  it('does not reuse blob IDs across backend, attach, session, clear or return-to-source changes', async () => {
    const { delivery, gw, session, backend, blob } = setup({ backend: undefined })
    const source = attachmentImagePath(attachedImage, delivery)
    if (!source) {
      throw new Error('missing gateway upload source')
    }
    await delivery.load(source)
    expect(delivery.preview(source).status).toBe('ready')
    backend('docker')
    expect(delivery.preview(source).status).toBe('available')
    backend(undefined)
    expect(delivery.preview(source).status).toBe('available')
    gw.attached = false
    expect(delivery.preview(source).status).toBe('unsupported')
    gw.attached = true
    expect(delivery.preview(source).status).toBe('available')
    session('a-second-session')
    expect(delivery.preview(source).status).toBe('available')
    await delivery.load(source)
    expect(gw.sent('hermes-tern.media.image').at(-1)).toEqual({
      session_id: 'a-second-session', path: attachedImage
    })
    delivery.clear()
    expect(delivery.preview(source).status).toBe('available')
    expect(blob).toHaveBeenCalledTimes(2) // no cached blob ID survived any transition
  })

  it('drops stale successful RPC replies on session/backend changes and retries after failure', async () => {
    const { delivery, gw, backend, session, blob } = setup({ backend: undefined })
    const source = attachmentImagePath(attachedImage, delivery)
    if (!source) {
      throw new Error('missing gateway upload source')
    }
    const wait = Promise.withResolvers<unknown>()
    gw.handlers.set('hermes-tern.media.image', () => wait.promise)
    const pending = delivery.load(source)
    await vi.waitFor(() => expect(gw.sent('hermes-tern.media.image')).toHaveLength(1))
    backend('docker')
    expect(delivery.preview(source).status).toBe('busy')
    session('another-session')
    wait.resolve(response())
    await pending
    expect(blob).not.toHaveBeenCalled()
    gw.handlers.set('hermes-tern.media.image', () => { throw new Error('No committed proof') })
    await delivery.load(source)
    expect(delivery.preview(source)).toMatchObject({ status: 'failed', error: 'No committed proof' })
    expect(blob).not.toHaveBeenCalled()
    gw.handlers.set('hermes-tern.media.image', response)
    await delivery.load(source)
    expect(delivery.preview(source).status).toBe('ready')
    expect(blob).toHaveBeenCalledOnce()
  })

  it('refuses typed-marker image paths at backend proof despite a visible Load control', async () => {
    const { delivery, gw, blob } = setup({ backend: undefined })
    const source = attachmentImagePath('/gateway/typed-marker.png', delivery)
    if (!source) {
      throw new Error('missing attachment route')
    }
    expect(delivery.preview(source).status).toBe('available')
    gw.handlers.set('hermes-tern.media.image', () => { throw new Error('Image is not an authorized, current attachment') })
    await delivery.load(source)
    expect(gw.sent('hermes-tern.media.image')).toEqual([
      { session_id: 'session-1', path: '/gateway/typed-marker.png' }
    ])
    expect(delivery.preview(source).status).toBe('failed')
    expect(blob).not.toHaveBeenCalled()
    const tool: MediaPath = { ...source, id: 'tool', toolCallId: 'typed-only', scope: 'attachment' }
    expect(delivery.preview(tool).status).toBe('unsupported')
    expect(gw.sent('hermes-tern.media.image')).toHaveLength(1)
  })
})
