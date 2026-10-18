// What a stored prompt carried, apart from the words the user wrote. Hermes persists an attached
// image as an `@image:<path>` line (tui_gateway/session_history.py), a native-vision turn as
// `[Image attached at: <path>]` hints plus one `[screenshot]` placeholder per image (the store's
// text-only projection), and `@file:` references expanded under `--- Attached Context ---`. The
// desktop lifts these out of the bubble (apps/desktop/src/lib/chat-messages/hydration.ts,
// lib/embedded-images.ts); so does this, keeping the attachments to show beside the words.

import { existsSync } from 'node:fs'
import { basename } from 'node:path'

import type { UserAttachment } from './model.js'

/** A reference's value: bare, or quoted with backticks, double or single quotes. */
const VALUE = '(`[^`\\n]+`|"[^"\\n]+"|\'[^\'\\n]+\'|\\S+)'
const IMAGE_LINE = new RegExp(`^@image:${VALUE}[ \\t]*$`, 'gm')
const SCREENSHOT_LINE = /^\[screenshot\][ \t]*(?:\n|$)/gm
// The native-vision suffix: a blank line, the hints, then the placeholders (none, or one each).
const HINTS = /\n\n((?:\[Image attached(?: at)?: [^\n]+\]\n?)+)((?:\[screenshot\](?:\n|$))*)$/
const ATTACHED_CONTEXT = /(?:^|\n)--- Attached Context ---\s*\n/
const CONTEXT_WARNINGS = /(?:^|\n)--- Context Warnings ---[\s\S]*$/
// The head line of each attached reference, as agent/context_references.py writes it (`📄 @file:…`).
const CONTEXT_REF = new RegExp(`^(?:\\S+ )?@(file|folder|url|image):${VALUE}`, 'gm')
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i

const unquote = (v: string) => (/^([`"']).*\1$/.test(v) ? v.slice(1, -1) : v)

/** A stored prompt split into the words to show and what it carried. */
export interface PromptParts {
  text: string
  /** Image paths (or URLs, for a remote image), in order. */
  images: string[]
  /** Files the attached context expanded, as referenced, with the disk path an image file gives. */
  files: { ref: string; path?: string }[]
}

/** Splits a stored user row into its words and its attachments. */
export function splitPrompt(raw: string): PromptParts {
  let text = raw
  let hinted: string[] = []

  const hints = HINTS.exec(text)

  if (hints) {
    const paths = [...(hints[1] ?? '').matchAll(/^\[Image attached(?: at)?: (.+)\]$/gm)].map(m => m[1]!)
    const placeholders = (hints[2] ?? '').split('[screenshot]').length - 1

    if (placeholders === 0 || placeholders === paths.length) {
      text = text.slice(0, hints.index)
      hinted = paths
    }
  }

  const refs: string[] = []
  text = text.replace(IMAGE_LINE, (_line, value: string) => {
    refs.push(unquote(value))

    return ''
  })

  // The placeholders stand for the refs' images; with no ref, a `[screenshot]` is the user's own.
  if (refs.length) {
    text = text.replace(SCREENSHOT_LINE, '')
  }

  const files: PromptParts['files'] = []
  const marker = ATTACHED_CONTEXT.exec(text)

  if (marker) {
    const context = text.slice(marker.index + marker[0].length)
    text = text.slice(0, marker.index)

    for (const m of context.matchAll(CONTEXT_REF)) {
      const ref = `@${m[1]}:${m[2]}`
      const end = context.indexOf('\n', m.index)
      const line = context.slice(m.index, end < 0 ? undefined : end)
      const disk = /available on disk at `([^`]+)`/.exec(line)?.[1]

      // A ref the words still hold shows there; only the ones they lost are listed.
      if (!text.includes(ref) && !files.some(f => f.ref === ref)) {
        files.push({ ref, ...(disk ? { path: disk } : {}) })
      }
    }
  }

  return { files, images: [...refs, ...hinted], text: text.replace(CONTEXT_WARNINGS, '').replace(/\n{3,}/g, '\n\n').trim() }
}

/** A stored prompt's attachments, each image with its file when that is still on disk. */
export function promptAttachments(parts: PromptParts, exists: (path: string) => boolean = existsSync): UserAttachment[] {
  const local = (p: string) => p.startsWith('/') && exists(p)

  return [
    ...parts.images.map(p => ({ kind: 'image' as const, name: basename(p), ...(local(p) ? { source: { path: p } } : {}) })),
    ...parts.files.map(({ path, ref }): UserAttachment => {
      const name = basename(unquote(ref.replace(/^@\w+:/, '')))

      return path && IMAGE_FILE.test(path) && local(path)
        ? { kind: 'image', name, source: { path } }
        : { kind: 'file', name }
    })
  ]
}
