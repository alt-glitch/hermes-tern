// The images the draft carries: a paste with no text (what a terminal sends for a clipboard image),
// a pasted or dropped image path, Ctrl+V, `/image <path>` and the launcher's `--image`. Each one
// shows a chip at once that says "attaching…" while it is read and uploaded, and the next prompt
// entered takes every image that landed.

import { existsSync } from 'node:fs'
import { basename } from 'node:path'

import type { GatewayClient } from '@tui/gatewayClient.js'

import { errorText } from '../core/errors.js'
import { imagePathOf, withClipboardImage } from '../hermes/clipboardImage.js'
import { type Attachment, imageSize, uploadImage } from '../hermes/images.js'
import type { ImageSource, NoticeEntry } from '../model.js'
import type { ComposerImage } from '../view/dock.js'
import { rpc } from '../wire/rpc.js'

/**
 * An uploaded image a prompt carries (the shared gateway takes it on prompt.submit), with the name
 * its chip shows, and the thumbnail and size the chip and the prompt's bubble show.
 */
export type Image = Attachment & { name: string; preview?: ImageSource; caption?: string }

/** An image being read or uploaded: its chip, until it lands or fails. */
interface Slot {
  name: string
}

/** Hands the clipboard's image file to `use`; undefined when the clipboard holds none. */
export type ClipboardReader = (use: (path: string) => Promise<boolean>) => Promise<boolean | undefined>

/** What the attachments reach of the app. */
export interface AttachmentsHost {
  /** Uploads go to it; a private gateway takes the startup image by path. */
  readonly gw: Pick<GatewayClient, 'isCanonical' | 'request'>
  /** The folder the launcher ran in: an upload's path resolves against it. */
  readonly launchCwd: string
  /** The open session's runtime id: null before the first session and while the gateway is down. */
  sid(): string | null
  /** The folder a pasted or typed path resolves against: the session's, else the launcher's. */
  cwd(): string
  /** A transcript notice; the store asks for the render. */
  note(text: string, tone: NoticeEntry['tone']): void
  /** Asks for a render. */
  changed(): void
  /** `bytes` sent to Tern as a blob; undefined where it takes none. */
  blob(bytes: Uint8Array, mime: string): string | undefined
  /**
   * Puts the startup image on the prompt at the queue's head (the startup query waits there for
   * it), in place; false when the queue is empty, and the draft takes it.
   */
  attachToHead(image: Image): boolean
}

/** The draft's images, and those still on their way. */
export class Attachments {
  readonly #host: AttachmentsHost
  readonly #clipboard: ClipboardReader
  /** The images attached to the draft: the next prompt entered takes them. */
  #items: Image[] = []
  /** Images being read or uploaded for the draft: an "attaching…" chip each until they land. */
  #pending: Slot[] = []
  /** The launcher's startup image until it is attached to the first session (the queue waits for it). */
  #startup: string

  /** `startup`: the launcher's `--image` (''); `clipboard`: reads the clipboard's image (tests fake it). */
  constructor(host: AttachmentsHost, { clipboard = use => withClipboardImage(use), startup = '' }: { clipboard?: ClipboardReader; startup?: string } = {}) {
    this.#host = host
    this.#clipboard = clipboard
    this.#startup = startup
  }

  /** The images that landed, in the order they were attached. */
  get items(): readonly Image[] {
    return this.#items
  }

  /** An image is still being read or uploaded: a prompt sent now would miss it. */
  get uploading(): boolean {
    return this.#pending.length > 0
  }

  /** Any image, landed or on its way: the draft is not empty. */
  get any(): boolean {
    return this.#items.length > 0 || this.#pending.length > 0
  }

  /** The launcher's startup image is still to be attached (the queue waits for it). */
  get awaitingStartup(): boolean {
    return Boolean(this.#startup)
  }

  /** A paste that is an image (no text: the clipboard's; one image path: that file); false for text. */
  paste(text: string): boolean {
    if (!text.trim()) {
      void this.fromClipboard(true)

      return true
    }

    const path = imagePathOf(text, this.#host.cwd())

    if (path) {
      void this.#attach(path, basename(path))

      return true
    }

    return false
  }

  /** Attaches the clipboard's image to the next prompt (`quiet`: an empty paste, which may hold none). */
  async fromClipboard(quiet: boolean) {
    // The chip shows at once; reading the clipboard and uploading fill it in.
    const slot = this.#start(`pasted image ${this.#items.length + this.#pending.length + 1}`)

    try {
      const found = await this.#clipboard(async path => {
        await this.#attach(path, slot.name, slot)

        return true
      })

      if (!found && !quiet) {
        this.#host.note('No image on the clipboard.', 'warning')
      }
    } catch (error) {
      this.#host.note(`Could not read the clipboard image: ${errorText(error)}`, 'error')
    } finally {
      this.#end(slot)
      this.#host.changed()
    }
  }

  /** `/image <path>`: attaches that image file (resolved against the session's folder) to the next prompt. */
  async fromPath(raw: string) {
    const path = imagePathOf(raw, this.#host.cwd())

    if (!path) {
      this.#host.note(`Not an image file: ${raw.trim()} (PNG, JPEG, GIF or WebP)`, 'warning')

      return this.#host.changed()
    }

    await this.#attach(path, basename(path))
  }

  /**
   * `hermes -q … --image …`: attaches the launcher's image to session `sid` (the first one): on the
   * shared gateway to the startup query at the queue's head, else by path to the session itself.
   * A failure is a warning, and the queue goes on without it.
   */
  async attachStartup(sid: string) {
    const path = this.#startup

    try {
      if (this.#host.gw.isCanonical) {
        const image = this.#image(await uploadImage(this.#host.gw, sid, path, this.#host.launchCwd), basename(path))

        if (!this.#host.attachToHead(image)) {
          this.#items.push(image)
        }
      } else {
        await rpc(this.#host.gw, 'image.attach', { path, session_id: sid })
      }
    } catch (error) {
      this.#host.note(`Could not attach ${path}: ${errorText(error)}`, 'warning')
    }

    this.#startup = ''
  }

  /** The draft's images, which leave the composer with the prompt that takes them. */
  take(): Image[] {
    const images = this.#items
    this.#items = []

    return images
  }

  /** A prompt that did not go is back in the composer: its images go before the draft's. */
  restore(images: readonly Image[]) {
    this.#items = [...images, ...this.#items]
  }

  /** The images that landed go; one still uploading lands after (Esc Esc). */
  clear() {
    this.#items = []
  }

  /** Every image goes, and the uploads in flight land nowhere (Ctrl+C). */
  clearAll() {
    this.#items = []
    this.#pending = []
  }

  /** The composer's chips: the landed images, then those on their way. */
  chips(): ComposerImage[] {
    return [
      ...this.#items.map(a => ({
        ...(a.caption === undefined ? {} : { caption: a.caption }),
        ...(a.preview ? { image: a.preview } : {}),
        label: a.name
      })),
      ...this.#pending.map(slot => ({ label: slot.name, pending: true }))
    ]
  }

  /** Chip `index`'s ✕: a landed image leaves the draft; one on its way lands nowhere. */
  remove(index: number) {
    const slot = this.#pending[index - this.#items.length]

    if (index < this.#items.length) {
      this.#items.splice(index, 1)
    } else if (slot) {
      this.#end(slot)
    }

    this.#host.changed()
  }

  /** Uploads `path` for the next prompt; its chip says "attaching…" (in `slot`) until it lands or fails. */
  async #attach(path: string, name: string, slot = this.#start(name)) {
    const sid = this.#host.sid()

    try {
      if (!sid) {
        this.#host.note('Wait for the session to start before attaching an image.', 'warning')

        return
      }

      const image = this.#image(await uploadImage(this.#host.gw, sid, path, this.#host.launchCwd), name)

      // Its chip was removed (✕, Ctrl+C) while it uploaded: the prompt does not take it.
      if (this.#pending.includes(slot)) {
        this.#items.push(image)
      }
    } catch (error) {
      this.#host.note(`Could not attach ${name}: ${errorText(error)}`, 'error')
    } finally {
      this.#end(slot)
      this.#host.changed()
    }
  }

  #start(name: string): Slot {
    const slot = { name }
    this.#pending.push(slot)
    this.#host.changed()

    return slot
  }

  #end(slot: Slot) {
    this.#pending = this.#pending.filter(s => s !== slot)
  }

  /**
   * An uploaded image with its thumbnail: its bytes as a blob, else the gateway's copy where that
   * is on this machine. The bytes are not kept.
   */
  #image({ bytes, ...attachment }: Attachment & { bytes: Buffer }, name: string): Image {
    const size = imageSize(bytes)
    const kb = bytes.length / 1024
    const blob = this.#host.blob(bytes, attachment.mime)
    const preview = blob ? { blob } : existsSync(attachment.path) ? { path: attachment.path } : undefined
    const caption = [size && `${size.w}×${size.h}`, kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} KB`]

    return { ...attachment, caption: caption.filter(Boolean).join(' · '), name, ...(preview ? { preview } : {}) }
  }
}
