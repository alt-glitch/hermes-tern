// A prompt on its way to the agent: one the user typed, one the app writes, or one a slash
// command made. The kind says how it is sent: only a typed prompt runs its `{!cmd}`s, and only a
// command's prompt shows other words than it sends (a skill's invocation, not its body).

import type { Image } from '../draft/attachments.js'
import type { UserAttachment } from '../model.js'

/**
 * What a prompt of images alone asks, as Ink (ui-tui/src/app/submissionCore.ts) and the desktop
 * (use-prompt-actions/submit.ts) send it: Hermes takes no empty prompt text.
 */
export const IMAGE_ONLY_PROMPT = 'What do you see in this image?'

/**
 * A prompt to send, or waiting to be sent, with the images that were attached when it was
 * entered. `images` is the prompt's own array: the launcher's startup image joins the startup
 * query at the queue's head in place.
 */
export type Prompt =
  /** Entered in the composer (or written by the app through it): its `{!cmd}`s run when it is sent, except those in `pasted`. */
  | { kind: 'typed'; text: string; images: Image[]; pasted: readonly string[] }
  /** Written by the app (the startup query, a steer that fell back, a command's send, an expanded prompt): sent as it is. */
  | { kind: 'app'; text: string; images: Image[] }
  /** A slash command's (a skill's body, a `send`): `display` is what the transcript, the queue and Edit show instead of `text`. */
  | { kind: 'command'; text: string; images: Image[]; display: string | undefined }

/** What the transcript, the queue and Edit show of `prompt`. */
export function shownText(prompt: Prompt): string {
  return (prompt.kind === 'command' ? prompt.display : undefined) ?? prompt.text
}

/** A queued prompt's dock line, and an admission's bubble: its words and how many images it carries. */
export function userText(text: string, images: readonly unknown[]): string {
  const count = images.length ? `📎 ${images.length} image${images.length === 1 ? '' : 's'}` : ''

  return [text, count].filter(Boolean).join('\n\n')
}

/** A sent prompt's images, drawn as thumbnails in its bubble. */
export function userImages(images: readonly Image[]): UserAttachment[] {
  return images.map(i => ({ kind: 'image', name: i.name, ...(i.preview ? { source: i.preview } : {}) }))
}
