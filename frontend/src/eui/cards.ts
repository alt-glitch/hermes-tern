// ephemeral-ui cards in the transcript: finds `ephemeral-ui` fences in an answer, mounts each
// card in the kit's DOM sandbox, and hands the view a snapshot, a click path, blobs for the
// card's SVG and stylesheet rules for its inline styles. Presentation only: no card reaches the
// gateway, and a card's buttons act on the card alone (its demo content is the kit's, synthetic).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodeEuiCard, EUI_FENCE, type EuiCardSpec } from '../wire/euiCard.js'
import { parseJson } from '../wire/json.js'

import { createSandbox, type EuiMounted, type EuiNode, type EuiSandbox, vendorDir } from './sandbox.js'

export type EuiPart =
  | { readonly kind: 'md'; readonly text: string }
  | { readonly kind: 'card'; readonly key: string; readonly spec: EuiCardSpec }
  | { readonly kind: 'bad'; readonly text: string; readonly error: string }

export interface EuiCardView {
  readonly spec: EuiCardSpec
  readonly app: string
  readonly label: string
  readonly node: EuiNode | null
  readonly error?: string
}

export interface EuiSink {
  blob(bytes: Uint8Array, mime: string): string | undefined
  stylesheet(name: string, css: string): void
}

const MAX_CARDS = 48
const MAX_BLOBS = 512
const FENCE = new RegExp(String.raw`(^|\n)([ \t]*)(\`{3,}|~{3,})[ \t]*${EUI_FENCE}[ \t]*\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)`, 'g')
export const INLINE_SHEET = 'ephemeral-ui-inline'
export const KIT_SHEET = 'ephemeral-ui'
/** The card stylesheets as last sent, which a recovered surface gets again (surface/host.ts). */
export const euiSheets = new Map<string, string>()

/** The tracked kit beside the source (vitest) or beside dist/entry.js (the bundle). */
export function euiDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))

  return vendorDir([resolve(here, '../vendor/ephemeral-ui'), resolve(here, '../src/vendor/ephemeral-ui')])
}

let kitCss: string | undefined

/** The kit's scoped stylesheet with its host variables bound to Tern's theme. */
export function euiStyles(): string {
  if (kitCss !== undefined) {
    return kitCss
  }

  const dir = euiDir()
  const kit = dir ? readFileSync(join(dir, 'kit.css'), 'utf8') : ''
  kitCss = `${kit}
[data-eui='card'] { --h-bg: var(--l1); --h-fg: var(--t1); --h-card: var(--card, var(--l1)); --h-card-solid: var(--card, var(--l1)); --h-muted: var(--l2); --h-mutedFg: var(--t3); --h-accent: var(--l2); --h-border: var(--l3); --h-input: var(--l3); --h-primary: var(--accent); --h-primaryFg: var(--accent-ink, var(--card)); --h-font: var(--sans); --h-mono: var(--mono); display: block; max-width: 560px; margin: 8px 0; color: var(--h-fg); font: 14px/1.45 var(--h-font); }
[data-eui='card'] [data-eui-svg] { display: inline-block; vertical-align: middle; flex: none; }
[data-role='eui.error'] { color: var(--sf-c-error, var(--t2)); font: 12px/1.4 var(--mono); }
`

  return kitCss
}

/** The kinds the pinned schema lists (card.v0.json properties.kind.enum). */
function pinnedKinds(dir: string): readonly string[] {
  if (!dir) {
    return []
  }

  const pin = parseJson(readFileSync(join(dir, 'PIN.json'), 'utf8'))
  const kinds: unknown = pin && typeof pin === 'object' && 'kinds' in pin ? pin.kinds : undefined

  return Array.isArray(kinds) ? kinds.filter((k): k is string => typeof k === 'string') : []
}

/** Splits an answer at its closed `ephemeral-ui` fences; `block` keys each card. */
export function splitEuiFences(text: string, block: string, kinds: readonly string[]): EuiPart[] {
  if (!text.includes(EUI_FENCE)) {
    return [{ kind: 'md', text }]
  }

  const parts: EuiPart[] = []
  let at = 0
  let n = 0

  for (const m of text.matchAll(FENCE)) {
    const start = m.index + (m[1]?.length ?? 0)
    const before = text.slice(at, start)

    if (before.trim()) {
      parts.push({ kind: 'md', text: before })
    }

    const decoded = decodeEuiCard(m[4] ?? '', kinds)
    parts.push('error' in decoded ? { kind: 'bad', text: m[0].slice(m[1]?.length ?? 0), error: decoded.error } : { kind: 'card', key: `${block}:${n++}`, spec: decoded })
    at = m.index + m[0].length
  }

  const rest = text.slice(at)

  if (rest.trim() || parts.length === 0) {
    parts.push({ kind: 'md', text: rest })
  }

  return parts
}

interface Slot {
  spec: EuiCardSpec
  mounted?: EuiMounted
  error?: string
}

export class EuiCards {
  revision = 0
  readonly dir = euiDir()
  readonly kinds = pinnedKinds(this.dir)
  #sink: EuiSink | undefined
  #changed: () => void
  #dark = false
  #sandbox: Promise<EuiSandbox> | undefined
  #slots = new Map<string, Slot>()
  #blobs = new Map<string, string>()
  #rules = new Map<string, string>()
  #sheetDirty = false

  constructor(changed: () => void, sink?: EuiSink) {
    this.#changed = changed
    this.#sink = sink
  }

  attach(sink: EuiSink, dark: boolean) {
    this.#sink = sink
    this.#blobs.clear()
    euiSheets.clear()
    this.theme(dark)
    this.#flush()
  }

  /** Tern's light/dark flip remounts every card against the kit theme of that polarity. */
  theme(dark: boolean) {
    if (dark === this.#dark && this.#sandbox) {
      return
    }

    this.#dark = dark
    this.#sandbox = undefined
    this.#reset()
  }

  split(text: string, block: string): EuiPart[] {
    return this.kinds.length ? splitEuiFences(text, block, this.kinds) : [{ kind: 'md', text }]
  }

  /** The card's current state, mounting it on first sight. */
  view(key: string, spec: EuiCardSpec): EuiCardView {
    let slot = this.#slots.get(key)

    if (!slot || slot.spec.kind !== spec.kind || slot.spec.app !== spec.app) {
      slot?.mounted?.dispose()
      slot = { spec }
      this.#slots.set(key, slot)
      this.#evict()
      this.#mount(key, slot)
    }

    const m = slot.mounted

    return { spec, app: m?.app ?? spec.app, label: m?.label ?? spec.kind, node: m ? m.snapshot() : null, ...(slot.error === undefined ? {} : { error: slot.error }) }
  }

  click(key: string, id: number) {
    if (this.#slots.get(key)?.mounted?.click(id)) {
      this.#bump()
    }
  }

  /** A blob id for one SVG, sent once and reused while it lasts. */
  svg(markup: string): string | undefined {
    const hit = this.#blobs.get(markup)

    if (hit !== undefined || !this.#sink) {
      return hit
    }

    const id = this.#sink.blob(new TextEncoder().encode(themeSvg(markup)), 'image/svg+xml')

    if (id !== undefined) {
      if (this.#blobs.size >= MAX_BLOBS) {
        this.#blobs.delete(this.#blobs.keys().next().value ?? '')
      }
      this.#blobs.set(markup, id)
    }

    return id
  }

  /** The `data-eui-s` value that carries an element's inline style (Tern nodes take no style). */
  style(css: string): string {
    const key = createHash('sha1').update(css).digest('hex').slice(0, 10)

    if (!this.#rules.has(key)) {
      this.#rules.set(key, `[data-eui-s='${key}']{${css.replace(/[{}<]/g, '')}}`)
      this.#sheetDirty = true
      queueMicrotask(() => { this.#flush() })
    }

    return key
  }

  close() {
    this.#reset()
    this.#sink = undefined
  }

  #flush() {
    if (!this.#sink) {
      return
    }
    if (!euiSheets.has(KIT_SHEET)) {
      euiSheets.set(KIT_SHEET, euiStyles())
      this.#sink.stylesheet(KIT_SHEET, euiStyles())
    }
    if (this.#sheetDirty) {
      this.#sheetDirty = false
      const css = [...this.#rules.values()].join('\n')
      euiSheets.set(INLINE_SHEET, css)
      this.#sink.stylesheet(INLINE_SHEET, css)
    }
  }

  #mount(key: string, slot: Slot) {
    this.#sandbox ??= createSandbox(this.dir, this.#dark ? 'dark' : 'light')
    this.#sandbox.then(sb => {
      if (this.#slots.get(key) !== slot) {
        return
      }
      slot.mounted = sb.mount(slot.spec.kind, slot.spec.app, () => { this.#bump() })
      this.#bump()
    }).catch((e: unknown) => {
      slot.error = e instanceof Error ? e.message : String(e)
      this.#bump()
    })
  }

  #evict() {
    while (this.#slots.size > MAX_CARDS) {
      const [first] = this.#slots.keys()

      if (first === undefined) {
        return
      }
      this.#slots.get(first)?.mounted?.dispose()
      this.#slots.delete(first)
    }
  }

  #reset() {
    if (this.#slots.size === 0) {
      return
    }
    for (const s of this.#slots.values()) {
      s.mounted?.dispose()
    }
    this.#slots.clear()
    this.#bump()
  }

  #bump() {
    this.revision++
    this.#changed()
  }
}

/** The kit's SVG ink uses its host variables; Tern's SVG images resolve only its own tokens. */
export function themeSvg(svg: string): string {
  return svg
    .replace(/currentColor/g, 'var(--text)')
    .replace(/var\(--h-(fg|primaryFg)\)/g, 'var(--text)')
    .replace(/var\(--h-(mutedFg|border|input)\)/g, 'var(--muted)')
    .replace(/var\(--h-primary\)/g, 'var(--accent)')
}
