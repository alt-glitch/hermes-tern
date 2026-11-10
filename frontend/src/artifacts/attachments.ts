// A negotiated Tern paste/drop may carry a base64 image instead of a host path.
// Validate limits and file signatures before uploading bytes to Hermes' gateway.

import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { GatewayClient } from '@hermes/shared/gateway-client'

import { ternSharesFrontendHost } from './links.js'

import { imageFormat } from '../hermes/images.js'
import { record } from '../wire/json.js'

export const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_TOTAL_IMAGE_BYTES = 40 * 1024 * 1024
export const MAX_IMAGES = 8
const MAX_IMAGE_BASE64_LENGTH = 4 * Math.ceil(MAX_PASTED_IMAGE_BYTES / 3)

/** Size from a canonical data URL before creating a Buffer. */
export function encodedImageBytes(data: string): number {
  if (data.length > Math.ceil(MAX_PASTED_IMAGE_BYTES * 4 / 3) + 128) {
    throw new Error('the image is larger than 20 MB')
  }
  const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(data)
  const encoded = match?.[1]
  if (!encoded || encoded.length % 4 !== 0) throw new Error('invalid base64 image')
  const size = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0)
  if (size < 1 || size > MAX_PASTED_IMAGE_BYTES) throw new Error('the image is larger than 20 MB')
  return size
}

/** Native path authority is never inferred across a Tern SSH stream or attached gateway. */
export function nativePathIsLocal(gw: Pick<GatewayClient, 'attached'>, env: NodeJS.ProcessEnv = process.env): boolean {
  return !gw.attached && ternSharesFrontendHost(env)
}

export type NativeImageEvent =
  | { kind: 'data'; data: string; name: string }
  | { kind: 'path'; path: string; name: string }
  | { kind: 'rejected'; reason: string }


export interface PastedImage {
  bytes: Buffer
  mime: string
  ext: string
}

/** Accept canonical, bounded PNG/JPEG/GIF/WebP data URLs only. */
export function decodePastedImage(data: string): PastedImage {
  // Validate and bound the allocation before decoding untrusted base64.
  encodedImageBytes(data)

  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(data)

  if (!match?.[1] || !match[2]) {
    throw new Error('not a PNG, JPEG, GIF or WebP base64 image')
  }

  const encoded = match[2]
  if (encoded.length % 4 !== 0) {
    throw new Error('invalid base64 image')
  }

  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || bytes.length > MAX_PASTED_IMAGE_BYTES || bytes.toString('base64') !== encoded) {
    throw new Error('invalid or oversized base64 image')
  }

  const format = imageFormat(bytes)
  if (!format || format.mime !== match[1].toLowerCase()) {
    throw new Error('image MIME and file signature mismatch')
  }

  return { bytes, ...format }
}

/** A native image intent. Host paths remain raw authority, names are display-only. */
export function pastedImageEvent(value: unknown): NativeImageEvent | undefined {
  const outer = record(value)
  // Tern 0.1.0 decodeEvent's default wraps unrecognized native paste/drop wire frames.
  const event = outer?.['ev'] === 'unknown' ? record(outer['raw']) : outer
  if (event?.['ev'] !== 'paste' && event?.['ev'] !== 'drop') return undefined

  const raw = record(event['raw']) ?? event
  const candidate = raw['name']
  const name = typeof candidate === 'string' && candidate.length <= 120 &&
    !Array.from(candidate).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && candidate.trim()
    ? candidate : 'Pasted image'

  // A structured raw.path is an explicit native intent. Never parse editor text as a path.
  const path = raw['path']
  if (typeof path === 'string' && path.length <= 4096 &&
    !Array.from(path).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    let file = path
    if (path.startsWith('file://')) {
      try { file = fileURLToPath(path) } catch { return undefined }
    }
    if (isAbsolute(file) && !file.startsWith('//')) return { kind: 'path', path, name }
    return undefined
  }

  const data = raw['data']
  const mime = raw['mime']
  // Admission for bare base64 must precede constructing another large string.
  if (typeof data === 'string' && !data.startsWith('data:image/') &&
    typeof mime === 'string' && /^image\/(?:png|jpeg|gif|webp)$/i.test(mime) &&
    data.length > MAX_IMAGE_BASE64_LENGTH) {
    return { kind: 'rejected', reason: 'Could not attach native image: the image is larger than 20 MiB.' }
  }
  const encoded = typeof data === 'string' && data.startsWith('data:image/')
    ? data
    : typeof data === 'string' && typeof mime === 'string' && /^image\/(?:png|jpeg|gif|webp)$/i.test(mime)
      ? 'data:' + mime + ';base64,' + data
      : undefined

  return encoded ? { kind: 'data', data: encoded, name } : undefined
}
