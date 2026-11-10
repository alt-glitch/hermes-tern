// Images attached to the composer, uploaded to the owning Hermes session.
// Ownership is a SessionState.ref object, not a runtime id: reused ids never adopt old work.

import { constants, existsSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { GatewayClient } from '@hermes/shared/gateway-client'

import { MAX_IMAGES, MAX_PASTED_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, decodePastedImage, encodedImageBytes } from '../artifacts/attachments.js'
import { errorText } from '../core/errors.js'
import type { SessionIds } from '../core/ids.js'
import { imagePathOf } from '../hermes/clipboardImage.js'
import { stageImageBytes, type Attachment, imageFormat, imageSize } from '../hermes/images.js'
import type { ImageSource, NoticeEntry } from '../model.js'

/** A gateway path is the only submission identity; neither refs nor authorities go on the wire. */
export type Image = Attachment & { name: string; preview?: ImageSource; caption?: string }

export interface ComposerImage {
  label: string
  caption?: string
  image?: ImageSource
  pending?: boolean
}

/** A captured object identity, plus the stored and runtime ids in that exact ref. */
interface Owner {
  readonly ref: SessionIds
  readonly sid: string
  readonly stored: string | null
}

interface Slot {
  readonly name: string
  readonly owner: Owner
  /** Bytes reserved before allocation; retained even if a still-running chip was removed. */
  bytes: number
}

interface ImageOwner {
  readonly owner: Owner
  readonly bytes: number
}

export type ClipboardReader = (use: (path: string) => Promise<boolean>) => Promise<boolean | undefined>

export interface AttachmentsHost {
  /** Uploads go to it. */
  readonly gw: Pick<GatewayClient, 'request'>
  /** The folder the launcher ran in: an upload's path resolves against it. */
  readonly launchCwd: string
  /** Return the actual SessionState.ref object, never a copied {live, stored} value. */
  owner(): SessionIds
  cwd(): string
  note(text: string, tone: NoticeEntry['tone']): void
  changed(): void
  blob(bytes: Uint8Array, mime: string): string | undefined
  attachToHead(image: Image): boolean
}

export class Attachments {
  readonly #host: AttachmentsHost
  readonly #clipboard: ClipboardReader
  #items: Image[] = []
  /** Visible chips only. Removal does not end a running operation. */
  #pending: Slot[] = []
  /** Every operation still decoding/reading/uploading, including canceled work. */
  readonly #inflight = new Set<Slot>()
  /** Session and size stay local, never in the image object passed to the gateway. */
  readonly #identity = new WeakMap<Image, ImageOwner>()
  #startup: string

  /** `clipboard`: reads the clipboard's image; `startup`: the launcher's `--image` (''). */
  constructor(host: AttachmentsHost, { clipboard, startup = '' }: { clipboard: ClipboardReader; startup?: string }) {
    this.#host = host
    this.#clipboard = clipboard
    this.#startup = startup
  }

  #owner(): Owner | undefined {
    const ref = this.#host.owner()
    return ref.live ? { ref, sid: ref.live, stored: ref.stored } : undefined
  }

  #current(owner: Owner): boolean {
    const ref = this.#host.owner()
    return ref === owner.ref && ref.live === owner.sid && ref.stored === owner.stored
  }

  /** A switch invalidates visible chips immediately, even for A -> B -> A with the same sid. */
  #prune() {
    this.#items = this.#items.filter(image => {
      const identity = this.#identity.get(image)
      return identity !== undefined && this.#current(identity.owner)
    })
    this.#pending = this.#pending.filter(slot => this.#current(slot.owner))
  }

  get items(): readonly Image[] {
    this.#prune()
    return this.#items
  }

  get uploading(): boolean {
    this.#prune()
    return this.#pending.length > 0
  }

  get any(): boolean {
    this.#prune()
    return this.#items.length > 0 || this.#pending.length > 0
  }

  get awaitingStartup(): boolean {
    return Boolean(this.#startup)
  }

  /** All retained image bytes and all unsettled reservations, including canceled uploads. */
  #charged(): number {
    return this.#items.reduce((sum, image) => sum + (this.#identity.get(image)?.bytes ?? 0), 0) +
      [...this.#inflight].reduce((sum, slot) => sum + slot.bytes, 0)
  }

  #start(name: string): Slot | undefined {
    this.#prune()
    const owner = this.#owner()

    if (!owner) {
      this.#host.note('Wait for the session to start before attaching an image.', 'warning')
      this.#host.changed()
      return undefined
    }

    if (this.#items.length + this.#inflight.size >= MAX_IMAGES || this.#charged() >= MAX_TOTAL_IMAGE_BYTES) {
      this.#host.note('Composer attachment budget reached (8 images / 40 MiB). Remove an image first.', 'warning')
      this.#host.changed()
      return undefined
    }

    const slot: Slot = { name, owner, bytes: 0 }
    this.#inflight.add(slot)
    this.#pending.push(slot)
    this.#host.changed()
    return slot
  }

  /** Reserve actual byte size before Buffer allocation and before every gateway upload. */
  #reserve(slot: Slot, bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_PASTED_IMAGE_BYTES) {
      throw new Error('Image must be a file no larger than 20 MiB.')
    }

    if (this.#charged() - slot.bytes + bytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new Error('Composer attachment budget reached (8 images / 40 MiB).')
    }

    slot.bytes = bytes
  }

  #eligible(slot: Slot): boolean {
    return this.#pending.includes(slot) && this.#current(slot.owner)
  }

  #end(slot: Slot) {
    const visible = this.#pending.includes(slot) && this.#current(slot.owner)
    this.#pending = this.#pending.filter(s => s !== slot)
    this.#inflight.delete(slot)
    if (visible) this.#host.changed()
  }

  #failed(slot: Slot, message: string) {
    if (this.#eligible(slot)) this.#host.note(message, 'error')
  }

  /** Read a regular local image with a bounded allocation; reject symlinks and racing growth. */
  async #uploadPath(slot: Slot, path: string): Promise<Attachment & { bytes: Buffer }> {
    const initial = statSync(path)
    if (!initial.isFile()) throw new Error('Image must be a regular file.')
    this.#reserve(slot, initial.size)

    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let bytes: Buffer
    try {
      const stat = await file.stat()
      if (!stat.isFile()) throw new Error('Image must be a regular file.')
      this.#reserve(slot, stat.size)
      if (!this.#eligible(slot)) throw new Error('Attachment was canceled.')
      bytes = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
        if (!bytesRead) throw new Error('Image changed while it was read.')
        offset += bytesRead
      }
      const after = await file.stat()
      if (after.size !== bytes.length) throw new Error('Image changed while it was read.')
    } finally {
      await file.close()
    }

    const format = imageFormat(bytes)
    if (!format) throw new Error('This file is not a PNG, JPEG, GIF or WebP image.')
    if (!this.#eligible(slot)) throw new Error('Attachment was canceled.')

    const result = await stageImageBytes(this.#host.gw, {
      session_id: slot.owner.sid,
      filename: 'image' + format.ext,
      content_base64: bytes.toString('base64')
    })
    if (!result?.path) throw new Error('the gateway did not store the image')
    return { bytes, mime: format.mime, path: result.path }
  }

  paste(text: string): boolean {
    if (text.startsWith('data:image/')) {
      void this.fromDataUrl(text)
      return true
    }
    if (!text.trim()) {
      void this.fromClipboard(true)
      return true
    }
    const path = imagePathOf(text, this.#host.cwd())
    if (!path) return false
    void this.#attach(path, basename(path))
    return true
  }

  async fromClipboard(quiet: boolean) {
    const slot = this.#start('pasted image ' + (this.#items.length + this.#pending.length + 1))
    if (!slot) return

    try {
      const found = await this.#clipboard(async path => {
        await this.#attach(path, slot.name, slot)
        return true
      })
      if (!found && !quiet && this.#eligible(slot)) this.#host.note('No image on the clipboard.', 'warning')
    } catch (error) {
      this.#failed(slot, 'Could not read the clipboard image: ' + errorText(error))
    } finally {
      this.#end(slot)
    }
  }

  async fromDataUrl(data: string, name = 'Pasted image') {
    const slot = this.#start(name)
    if (!slot) return
    try {
      // Encoded length is validated and charged before the decoder allocates the bytes.
      this.#reserve(slot, encodedImageBytes(data))
      if (!this.#eligible(slot)) return
      const { bytes, mime, ext } = decodePastedImage(data)
      const result = await stageImageBytes(this.#host.gw, {
        session_id: slot.owner.sid,
        filename: 'image' + ext,
        content_base64: bytes.toString('base64')
      })
      if (!result?.path) throw new Error('the gateway did not store the image')
      if (this.#eligible(slot)) this.#items.push(this.#image({ bytes, mime, path: result.path }, name, slot.owner))
    } catch (error) {
      this.#failed(slot, 'Could not attach ' + name + ': ' + errorText(error))
    } finally {
      this.#end(slot)
    }
  }

  async fromPath(raw: string) {
    const path = imagePathOf(raw, this.#host.cwd())
    if (!path) {
      this.#host.note('Not an image file: ' + raw.trim() + ' (PNG, JPEG, GIF or WebP)', 'warning')
      this.#host.changed()
      return
    }
    await this.#attach(path, basename(path))
  }

  /** Only a same-host Tern native event may introduce a filesystem path. */
  async fromNativePath(raw: string, sameHost: boolean) {
    if (!sameHost) {
      this.#host.note('A remote Tern or gateway path cannot be attached as a local file. Paste image bytes instead.', 'warning')
      this.#host.changed()
      return
    }
    let native = raw
    if (native.startsWith('file://')) {
      try {
        native = fileURLToPath(native)
      } catch {
        this.#host.note('Not a local image file: ' + raw, 'warning')
        this.#host.changed()
        return
      }
    }
    if (!isAbsolute(native) || native.startsWith('//') ||
      Array.from(native).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
      this.#host.note('Not a local image file: ' + raw, 'warning')
      this.#host.changed()
      return
    }
    const path = imagePathOf(native, this.#host.cwd())
    if (!path) {
      this.#host.note('Not a local image file: ' + raw, 'warning')
      this.#host.changed()
      return
    }
    await this.#attach(path, basename(path))
  }

  /** First session startup: preserve its exact owner through queue-head admission. */
  async attachStartup(sid: string) {
    const path = this.#startup
    const owner = this.#owner()
    if (!path) return

    if (!owner || owner.sid !== sid) {
      this.#host.note('Startup image has no matching active session.', 'warning')
      this.#startup = ''
      return
    }
    const slot = this.#start(basename(path))
    if (!slot) {
      this.#startup = ''
      return
    }
    try {
      const result = await this.#uploadPath(slot, imagePathOf(path, this.#host.launchCwd) ?? path)
      if (this.#eligible(slot)) {
        const image = this.#image(result, basename(path), owner)
        if (!this.#host.attachToHead(image)) this.#items.push(image)
      }
    } catch (error) {
      if (this.#eligible(slot)) this.#host.note('Could not attach ' + path + ': ' + errorText(error), 'warning')
    } finally {
      this.#startup = ''
      this.#end(slot)
    }
  }

  /** Revalidate taken/queued images when a prompt is about to enter the gateway. */
  ownsForSend(sid: string, images: readonly Image[]): boolean {
    const ref = this.#host.owner()
    return ref.live === sid && images.every(image => {
      const owner = this.#identity.get(image)?.owner
      return owner !== undefined && owner.sid === sid && this.#current(owner)
    })
  }

  /** Synchronous submission: never give a B prompt an A ref, even with a reused runtime id. */
  take(): Image[] {
    this.#prune()
    const taken = this.#items
    this.#items = []
    return taken
  }

  restore(images: readonly Image[]) {
    this.#prune()
    for (const image of [...images].reverse()) {
      const identity = this.#identity.get(image)
      if (!identity || !this.#current(identity.owner)) continue
      if (this.#items.includes(image)) continue
      if (this.#items.length + this.#inflight.size >= MAX_IMAGES ||
        this.#charged() + identity.bytes > MAX_TOTAL_IMAGE_BYTES) {
        this.#host.note('Composer attachment budget reached (8 images / 40 MiB). Remove an image first.', 'warning')
        continue
      }
      this.#items.unshift(image)
    }
  }

  clear() {
    this.#items = []
  }

  clearAll() {
    this.#items = []
    // The slots still in #inflight continue to count until their promises actually settle.
    this.#pending = []
  }

  chips(): ComposerImage[] {
    this.#prune()
    return [
      ...this.#items.map(a => ({
        ...(a.caption === undefined ? {} : { caption: a.caption }),
        ...(a.preview ? { image: a.preview } : {}),
        label: a.name
      })),
      ...this.#pending.map(slot => ({ label: slot.name, pending: true }))
    ]
  }

  remove(index: number) {
    this.#prune()
    if (index < 0 || !Number.isInteger(index)) return
    if (index < this.#items.length) {
      this.#items.splice(index, 1)
    } else {
      const slot = this.#pending[index - this.#items.length]
      if (slot) this.#pending = this.#pending.filter(s => s !== slot)
    }
    this.#host.changed()
  }

  async #attach(path: string, name: string, existing?: Slot) {
    const slot = existing ?? this.#start(name)
    if (!slot) return
    try {
      if (!this.#eligible(slot)) return
      const result = await this.#uploadPath(slot, path)
      if (this.#eligible(slot)) this.#items.push(this.#image(result, name, slot.owner))
    } catch (error) {
      this.#failed(slot, 'Could not attach ' + name + ': ' + errorText(error))
    } finally {
      if (!existing) this.#end(slot)
    }
  }

  #image({ bytes, ...attachment }: Attachment & { bytes: Buffer }, name: string, owner: Owner): Image {
    const size = imageSize(bytes)
    const kb = bytes.length / 1024
    const blob = this.#host.blob(bytes, attachment.mime)
    const preview = blob ? { blob } : existsSync(attachment.path) ? { path: attachment.path } : undefined
    const caption = [size && (size.w + '×' + size.h), kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(kb)) + ' KB']
    const image: Image = { ...attachment, caption: caption.filter(Boolean).join(' · '), name, ...(preview ? { preview } : {}) }
    this.#identity.set(image, { owner, bytes: bytes.length })
    return image
  }
}
