import { vi } from 'vitest'

import { MediaDelivery } from '../media-delivery.js'

import { FakeGateway, fakeTern } from './fakes.js'

export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVmQAAAAASUVORK5CYII=', 'base64')
export const response = () => ({ content_base64: png.toString('base64'), bytes: png.length, mime: 'image/png' })

interface Setup {
  readonly blobs?: boolean
  readonly attached?: boolean
  readonly backend?: string | null | undefined
  readonly env?: NodeJS.ProcessEnv
  readonly native?: boolean
}

export function setup(options: Setup = {}) {
  const { blobs = true, attached = true, env = {}, native = false } = options
  const gw = new FakeGateway({ replies: {
    'gateway.capabilities': () => ({ plugin_methods: ['hermes-tern.media.image'] }),
    'hermes-tern.media.image': response
  } })
  gw.attached = attached
  const tern = fakeTern({ features: blobs ? ['blobs'] : [] }).session
  Object.assign(tern.caps, { kinds: native ? ['media'] : [] })
  const blob = vi.spyOn(tern, 'blob').mockReturnValue('tern-blob')
  const changed = vi.fn()
  let sid: string | null = 'session-1'
  let currentBackend = Object.hasOwn(options, 'backend') ? options.backend : 'local'

  const delivery = new MediaDelivery({
    tern, gw: gw.client, changed,
    session: () => sid,
    cwd: () => '/gateway',
    backend: () => currentBackend,
    env
  })

  return {
    blob, changed, delivery, gw,
    session: (id: string | null) => { sid = id },
    backend: (name: string | null | undefined) => { currentBackend = name }
  }
}
