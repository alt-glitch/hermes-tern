// Images tool calls showed, as the desktop draws them (apps/desktop/src/lib/generated-images.ts,
// tool/fallback-model/index.ts): the picture image_generate made, a browser screenshot. Not the
// image vision_analyze looks at: that is mostly the user's own paste, so its card folds. A local file goes to Tern by `path`; a data URL, or an http(s) URL's
// bytes fetched once, go as a blob, the way the welcome logo does. A click on an `image` node
// opens it large in Tern's own lightbox.

import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

import { imageFormat } from './hermes/images.js'
import type { Entry, ImageSource, ToolCall } from './model.js'
import { record } from './wire/json.js'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** The largest blob Tern takes (wire.ts MAX_BLOB). */
const MAX_BYTES = 16 * 1024 * 1024
const FETCH_MS = 20_000

/**
 * Where the image a call showed lives (a path, `file://`, http(s) or data URL); undefined for a
 * call that showed none, failed, or (image_generate) has not answered yet.
 */
export function shownImage(call: ToolCall): string | undefined {
  if (call.status === 'error' || call.status === 'cancelled') {
    return undefined
  }

  const r = record(call.result)

  if (r?.success === false) {
    return undefined
  }

  if (call.name === 'image_generate') {
    // host_image is the file on this side when the image was made inside a sandbox.
    return str(r?.host_image) ?? str(r?.image)
  }

  if (call.name.startsWith('browser')) {
    // browser_vision: its native-vision envelope keeps the file in `meta`; the aux-model answer at the top.
    const summary = call.resultText ?? str(r?.text_summary) ?? ''

    return str(record(r?.meta)?.screenshot_path) ?? str(r?.screenshot_path) ?? /Screenshot path: (\S+)/.exec(summary)?.[1]
  }

  return undefined
}

/** `src` as a file Tern reads; undefined for a URL. */
export function localSource(src: string): ImageSource | undefined {
  if (/^file:\/\//i.test(src)) {
    try {
      return { path: fileURLToPath(src) }
    } catch {
      return undefined
    }
  }

  const path = src.replace(/^~(?=\/)/, homedir())

  return isAbsolute(path) ? { path } : undefined
}

/** What Media needs of Tern: a blob of these bytes, undefined where this Tern takes none. */
export interface MediaHost {
  blob(bytes: Uint8Array, mime: string): string | undefined
}

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>

/** Turns URLs into blobs, each once: a fetch in flight is shared, a failure is remembered. */
export class Media {
  readonly #host: MediaHost
  readonly #fetch: Fetch
  readonly #loads = new Map<string, Promise<ImageSource | null>>()
  /** What each settled load gave, so a call rebuilt from history gets it before the next frame. */
  readonly #loaded = new Map<string, ImageSource | null>()

  constructor(host: MediaHost, fetcher: Fetch = (url, init) => fetch(url, init)) {
    this.#host = host
    this.#fetch = fetcher
  }

  /**
   * Gets the image `call` shows ready: a URL's bytes land on `call.image` (null when they could
   * not be had) and `done` runs. A local file needs nothing; Tern reads it.
   */
  show(call: ToolCall, done: () => void) {
    const src = shownImage(call)

    if (!src || localSource(src) || call.image !== undefined) {
      return
    }

    if (this.#loaded.has(src)) {
      call.image = this.#loaded.get(src)
      return
    }

    void this.load(src).then(image => {
      call.image = image
      done()
    })
  }

  /** `show` for every call of `entries` (a transcript loaded from history). */
  showAll(entries: readonly Entry[], done: (call: ToolCall) => void) {
    for (const e of entries) {
      for (const b of e.kind === 'turn' ? e.blocks : []) {
        if (b.kind === 'tool') {
          this.show(b.call, () => done(b.call))
        }
      }
    }
  }

  /** `src` (a data or http(s) URL) as a blob; null when it is no image or cannot be fetched. */
  load(src: string): Promise<ImageSource | null> {
    let load = this.#loads.get(src)

    if (!load) {
      load = this.#bytes(src)
        .then(
          bytes => this.#blob(bytes),
          () => null
        )
        .then(image => {
          this.#loaded.set(src, image)

          return image
        })
      this.#loads.set(src, load)
    }

    return load
  }

  async #bytes(src: string): Promise<Buffer | undefined> {
    const data = /^data:image\/[\w.+-]+;base64,(.*)$/s.exec(src)

    if (data) {
      return Buffer.from(data[1] ?? '', 'base64')
    }

    if (!/^https?:\/\//i.test(src)) {
      return undefined
    }

    const r = await this.#fetch(src, { signal: AbortSignal.timeout(FETCH_MS) })
    const size = Number(r.headers.get('content-length') ?? 0)

    return r.ok && size <= MAX_BYTES ? Buffer.from(await r.arrayBuffer()) : undefined
  }

  #blob(bytes: Buffer | undefined): ImageSource | null {
    // Only bytes that are an image Tern decodes, and that fit in a blob.
    const format = bytes && bytes.length <= MAX_BYTES ? imageFormat(bytes) : null
    const blob = format && bytes ? this.#host.blob(bytes, format.mime) : undefined

    return blob ? { blob } : null
  }
}
