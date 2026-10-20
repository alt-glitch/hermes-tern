// Images on the shared gateway ride on `prompt.submit` as `{path, mime}` attachments the owner can
// read. `image.attach_bytes` uploads the bytes and answers with that path, for a local owner and a
// remote one alike. Size cap and format sniffing follow Hermes' ui-tui/src/lib/imageAttachments.ts.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, resolve } from 'node:path'

import type { GatewayClient } from '@tui/gatewayClient.js'

import { rpc } from '../wire/rpc.js'

export interface Attachment {
  path: string
  mime: string
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export function imageFormat(bytes: Buffer): { mime: string; ext: string } | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mime: 'image/png', ext: '.png' }
  }

  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return { mime: 'image/jpeg', ext: '.jpg' }
  }

  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) {
    return { mime: 'image/gif', ext: '.gif' }
  }

  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', ext: '.webp' }
  }

  return null
}

/** The pixel size an image's header gives (PNG, GIF, WebP, JPEG); undefined when it cannot be read. */
export function imageSize(bytes: Buffer): { w: number; h: number } | undefined {
  const format = imageFormat(bytes)?.mime
  const size = (w: number, h: number) => (w > 0 && h > 0 ? { h, w } : undefined)

  try {
    if (format === 'image/png') {
      return size(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
    }

    if (format === 'image/gif') {
      return size(bytes.readUInt16LE(6), bytes.readUInt16LE(8))
    }

    if (format === 'image/webp') {
      const chunk = bytes.subarray(12, 16).toString('ascii')

      if (chunk === 'VP8X') {
        return size(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1)
      }

      if (chunk === 'VP8L') {
        const b = bytes.readUInt32LE(21)

        return size((b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1)
      }

      return size(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff)
    }

    if (format === 'image/jpeg') {
      // The frame header (SOF0..SOF15 but DHT, JPG and DAC) holds the size; walk the segments to it.
      for (let i = 2; i + 9 < bytes.length; ) {
        if (bytes[i] !== 0xff) {
          return undefined
        }

        const marker = bytes.readUInt8(i + 1)

        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return size(bytes.readUInt16BE(i + 7), bytes.readUInt16BE(i + 5))
        }

        i += 2 + bytes.readUInt16BE(i + 2)
      }
    }
  } catch {
    // A header cut short.
  }

  return undefined
}

/**
 * Uploads the image at `raw` (relative to `cwd`, `~` expanded) for session `sid`. The bytes come
 * back too: the composer's thumbnail shows them (a clipboard image's file is gone right after).
 */
export async function uploadImage(
  gw: Pick<GatewayClient, 'request'>,
  sid: string,
  raw: string,
  cwd: string
): Promise<Attachment & { bytes: Buffer }> {
  const path = resolve(cwd, raw.replace(/^~(?=$|\/)/, homedir()))
  const bytes = await readFile(path)

  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('the image is larger than 20 MB')
  }

  const format = imageFormat(bytes)

  if (!format) {
    throw new Error(`${extname(path) || 'this file'} is not a PNG, JPEG, GIF or WebP image`)
  }

  const r = await rpc(gw, 'image.attach_bytes', {
    session_id: sid,
    filename: `image${format.ext}`,
    content_base64: bytes.toString('base64')
  })

  if (!r?.path) {
    throw new Error('the gateway did not store the image')
  }

  return { bytes, mime: format.mime, path: r.path }
}
