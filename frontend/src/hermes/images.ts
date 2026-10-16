// Images on the shared gateway ride on `prompt.submit` as `{path, mime}` attachments the owner can
// read. `image.attach_bytes` uploads the bytes and answers with that path, for a local owner and a
// remote one alike. Size cap and format sniffing follow Hermes' ui-tui/src/lib/imageAttachments.ts.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, resolve } from 'node:path'

import type { GatewayClient } from '@tui/gatewayClient.js'

export interface Attachment {
  path: string
  mime: string
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024

function imageFormat(bytes: Buffer): { mime: string; ext: string } | null {
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

/** Uploads the image at `raw` (relative to `cwd`, `~` expanded) for session `sid`. */
export async function uploadImage(gw: Pick<GatewayClient, 'request'>, sid: string, raw: string, cwd: string): Promise<Attachment> {
  const path = resolve(cwd, raw.replace(/^~(?=$|\/)/, homedir()))
  const bytes = await readFile(path)

  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('the image is larger than 20 MB')
  }

  const format = imageFormat(bytes)

  if (!format) {
    throw new Error(`${extname(path) || 'this file'} is not a PNG, JPEG, GIF or WebP image`)
  }

  const r = await gw.request<{ path?: string }>('image.attach_bytes', {
    session_id: sid,
    filename: `image${format.ext}`,
    content_base64: bytes.toString('base64')
  })

  if (!r?.path) {
    throw new Error('the gateway did not store the image')
  }

  return { path: r.path, mime: format.mime }
}
