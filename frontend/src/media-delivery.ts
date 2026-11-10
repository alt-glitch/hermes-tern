// Host-aware, explicit image previews. The SDK owns blob encoding and deduplication;
// this service keeps bounded metadata only, never decoded buffers in the cache.
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

import type { Session } from '@stencil-hq/tern'
import type { GatewayClient } from '@hermes/shared/gateway-client'

import { imageFormat } from './hermes/images.js'
import type { MediaContext } from './read-media.js'
import { hasNativeMedia } from './tern-media.js'

export const MEDIA_MAX_BYTES = 16 * 1024 * 1024
export const MEDIA_CACHE_ENTRIES = 32
export const MEDIA_CONNECTION_BYTES = 64 * 1024 * 1024
export const MEDIA_CONNECTION_BLOBS = 64

/** The path's owner is explicit; it is not necessarily the machine running Tern. */
export interface MediaPath {
  readonly kind: 'path'
  readonly host: 'tern' | 'frontend' | 'gateway' | 'compute'
  readonly id: string
  readonly path: string
  readonly mime?: string
  /** Exact completed gateway read; the gateway enforces session/path authorization. */
  readonly toolCallId?: string
  /** A persisted @image: reference; gateway authorizes the session-owned attachment. */
  readonly scope?: 'attachment'
}

export type PreviewState =
  | { readonly status: 'ready'; readonly blob: string }
  | { readonly status: 'available'; readonly label: 'Load image preview' }
  | { readonly status: 'failed'; readonly label: 'Retry preview'; readonly error: string }
  | { readonly status: 'loading' | 'busy' | 'unsupported' | 'exhausted'; readonly label: string }

export interface MediaDeliveryDeps {
  readonly tern: Pick<Session, 'blob' | 'caps'>
  readonly gw: Pick<GatewayClient, 'attached' | 'request'>
  readonly session: () => string | null
  readonly cwd: () => string | undefined
  readonly backend: () => string | null | undefined
  readonly changed: () => void
  readonly env?: NodeJS.ProcessEnv
}

/** SSH makes frontend/Tern host paths non-interchangeable, including stdio gateways. */
export function ternSharesFrontendHost(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env['SSH_CONNECTION'] && !env['SSH_CLIENT'] && !env['SSH_TTY']
}

/** Open only regular, non-symlink leaf files. Bound allocation and each read, even if file grows. */
export async function readImageBytes(path: string, maxBytes = MEDIA_MAX_BYTES): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))

  try {
    const stat = await file.stat()

    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > maxBytes) {
      throw new Error('Image must be a regular file no larger than 16 MiB.')
    }

    const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1))
    let length = 0

    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)

      if (!bytesRead) {
        break
      }

      length += bytesRead
    }

    if (length !== stat.size || length > maxBytes) {
      throw new Error('Image changed while reading; retry preview.')
    }

    return buffer.subarray(0, length)
  } finally {
    await file.close()
  }
}

/** Actual supported raster magic bytes must match any claimed MIME; file names prove nothing. */
export function imageBytesMime(bytes: Buffer, declared?: string): string {
  const mime = imageFormat(bytes)?.mime
  const reported = declared?.split(';')[0]?.trim().toLowerCase()

  if (!mime || (reported && reported !== 'application/octet-stream' && reported !== mime)) {
    throw new Error('Unsupported image or MIME/magic-byte mismatch.')
  }

  return mime
}

interface CachedImage {
  status: 'loading' | 'ready' | 'failed'
  blob?: string
  error?: string
}

/** One load at a time; explicit actions only; no automatic fetch while drawing. */
export class MediaDelivery {
  readonly #cache = new Map<string, CachedImage>()
  #busy = false
  #epoch = 0
  #closed = false
  #authority: string | undefined
  #bytes = 0
  #uploads = 0
  revision = 0

  constructor(readonly deps: MediaDeliveryDeps) {}

  /** The renderer's host decision follows the current gateway, backend, cwd and SSH context. */
  context(): MediaContext {
    const { gw, tern, env = process.env } = this.deps
    // Observe even local-only transitions: a former host must not reclaim an old blob.
    this.#scope()
    const backend = this.deps.backend()
    const known = typeof backend === 'string' && backend.trim().length > 0
    const compute = known && backend !== 'local'
    const local = Boolean(this.deps.session()) && backend === 'local' &&
      !gw.attached && ternSharesFrontendHost(env)

    return {
      cwd: this.deps.cwd(),
      local,
      native: hasNativeMedia(tern),
      remoteHost: !known ? 'unknown' : compute ? 'compute' : gw.attached ? 'gateway' : 'frontend'
    }
  }

  /** Include host/session state, not only async cache writes, in transcript node revisions. */
  token(): string {
    return JSON.stringify([this.revision, this.#epoch, this.#scope(), this.deps.tern.caps.kinds, this.deps.tern.caps.features])
  }

  preview(source: MediaPath): PreviewState {
    const host = this.context()
    const cached = this.#cache.get(this.#key(source))

    // Hermes has no public completed-tool/compute-host proof for this RPC.
    // Client-supplied tool IDs cannot mint authority, including when a
    // completed tool card or a mock gateway appears to return valid bytes.
    if (source.host === 'gateway' && source.toolCallId !== undefined) {
      return { label: 'Tool image preview unavailable: no authenticated completed-tool evidence.', status: 'unsupported' }
    }

    // An owned prompt attachment is gateway-staged, regardless of UNKNOWN
    // compute backend. This is only a routing hint for a user-initiated RPC:
    // Hermes must independently attest stored bytes and session ownership.
    // Tool-call paths do NOT inherit attachment provenance.
    const gatewayAttachment = source.host === 'gateway' &&
      source.scope === 'attachment' && !source.toolCallId && this.deps.gw.attached

    if ((source.scope === 'attachment' && !gatewayAttachment) ||
        (!gatewayAttachment && (host.local || source.host !== host.remoteHost))) {
      return { label: 'Image path does not belong to the active host.', status: 'unsupported' }
    }

    if (cached?.status === 'ready' && cached.blob) {
      return { blob: cached.blob, status: 'ready' }
    }

    if (this.#closed || !this.deps.session() || !this.deps.tern.caps.features.includes('blobs') ||
        source.host === 'tern' || source.host === 'compute' ||
        (source.host === 'gateway' && !source.toolCallId && source.scope !== 'attachment')) {
      return { label: 'Remote image preview unavailable on this host or SDK.', status: 'unsupported' }
    }

    if (this.#uploads >= MEDIA_CONNECTION_BLOBS || this.#bytes >= MEDIA_CONNECTION_BYTES) {
      return { label: 'Preview connection budget reached; reconnect to load more images.', status: 'exhausted' }
    }

    if (cached?.status === 'loading') {
      return { label: 'Loading image preview…', status: 'loading' }
    }

    if (cached?.status === 'failed') {
      return { error: cached.error ?? 'Image preview failed.', label: 'Retry preview', status: 'failed' }
    }

    return this.#busy
      ? { label: 'Another preview is loading…', status: 'busy' }
      : { label: 'Load image preview', status: 'available' }
  }

  async load(source: MediaPath): Promise<void> {
    const state = this.preview(source)

    if (state.status !== 'available' && state.status !== 'failed') {
      return
    }

    const session = this.deps.session()

    if (!session || this.#busy) {
      return
    }

    const key = this.#key(source)
    const scope = this.#scope()
    const epoch = this.#epoch
    const entry: CachedImage = { status: 'loading' }

    this.#cache.delete(key)

    while (this.#cache.size >= MEDIA_CACHE_ENTRIES) {
      const eldest = this.#cache.keys().next().value

      if (eldest === undefined) {
        break
      }

      this.#cache.delete(eldest)
    }

    this.#cache.set(key, entry)
    this.#busy = true
    this.#touch()

    try {
      let bytes: Buffer
      let responseMime = source.mime

      if (source.host === 'gateway') {
        // Discover only on explicit user action, in the attached live RPC
        // session domain. Older Hermes runtimes do not have plugin methods.
        const capabilities = await this.deps.gw.request<{ plugin_methods?: unknown }>(
          'gateway.capabilities', { session_id: session }
        )
        const methods = capabilities?.plugin_methods

        if (!Array.isArray(methods) || !methods.includes('hermes-tern.media.image')) {
          throw new Error('Image preview requires Hermes plugin gateway methods; upgrade Hermes and enable hermes-tern.')
        }

        if (this.#closed || epoch !== this.#epoch || scope !== this.#scope() || this.#cache.get(key) !== entry) {
          return
        }

        const response = await this.deps.gw.request<{
          content_base64: string
          bytes: number
          mime: string
        }>('hermes-tern.media.image', {
          session_id: session,
          path: source.path,
          ...(source.mime ? { mime: source.mime } : {}),
          ...(source.toolCallId ? { tool_call_id: source.toolCallId } : {})
        })

        const raw = response?.content_base64

        if (typeof raw !== 'string' || raw.length === 0 || raw.length % 4 !== 0 ||
            raw.length > Math.ceil(MEDIA_MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) {
          throw new Error('Invalid or oversized gateway image.')
        }

        bytes = Buffer.from(raw, 'base64')

        if (bytes.length > MEDIA_MAX_BYTES || response.bytes !== bytes.length ||
            bytes.toString('base64') !== raw) {
          throw new Error('Invalid or incomplete gateway image.')
        }

        responseMime = response.mime
      } else if (source.host === 'frontend') {
        bytes = await readImageBytes(source.path)
      } else {
        return
      }

      const mime = imageBytesMime(bytes, responseMime)
      imageBytesMime(bytes, source.mime)

      if (bytes.length > MEDIA_MAX_BYTES || this.#bytes + bytes.length > MEDIA_CONNECTION_BYTES ||
          this.#uploads >= MEDIA_CONNECTION_BLOBS) {
        throw new Error('Preview connection budget reached; reconnect to load more images.')
      }

      // A removed source or abandoned session must never upload, even if its RPC ignored cancellation.
      if (this.#closed || epoch !== this.#epoch || scope !== this.#scope() || this.#cache.get(key) !== entry) {
        return
      }

      const blob = this.deps.tern.blob(bytes, mime)
      this.#bytes += bytes.length
      this.#uploads++
      entry.status = 'ready'
      entry.blob = blob
    } catch (error) {
      if (this.#cache.get(key) === entry) {
        entry.status = 'failed'
        entry.error = error instanceof Error ? error.message : String(error)
      }
    } finally {
      this.#busy = false
      this.#touch()
    }
  }

  forget(source: MediaPath): void {
    this.#cache.delete(this.#key(source))
    this.#touch()
  }

  /** Clear transcript-owned previews, never the cumulative SDK-connection blob budget. */
  clear(close = false): void {
    this.#epoch++
    this.#closed ||= close
    this.#cache.clear()
    this.#touch()
  }

  #key(source: MediaPath): string {
    return JSON.stringify([this.#scope(), source.host, source.id, source.path, source.mime, source.toolCallId, source.scope])
  }

  #scope(): string {
    const { gw, env = process.env } = this.deps

    const current = JSON.stringify([
      this.deps.session(), this.deps.cwd(), this.deps.backend(), gw.attached, ternSharesFrontendHost(env)
    ])

    // Keying solely by the current values resurrects blobs after A -> B -> A.
    // Revoke all previous metadata and pending transfers on each observed authority change.
    if (this.#authority !== current) {
      this.#authority = current
      this.#cache.clear()
      this.#epoch++
    }

    return current
  }

  #touch(): void {
    if (!this.#closed) {
      this.revision++
      this.deps.changed()
    }
  }
}
