// A typed prompt's `{!cmd}`s, run before it is sent: each one's output takes its place in the
// text. A command that cannot run refuses the whole prompt, which goes back to the composer to
// edit. The busy path (a steer, a redirect, an admission) and a send both expand through here.

import type { LiveSessionId } from '../core/ids.js'
import type { Image } from '../draft/attachments.js'
import { interpolate, shellError, typedCommands } from '../hermes/shell.js'
import type { NoticeEntry } from '../model.js'
import type { Requester } from '../wire/rpc.js'

import type { Prompt, TypedPrompt } from './prompt.js'

/** The working row's label while a send's `{!cmd}`s run (busy counts it as a turn). */
export const EXPANDING_LABEL = 'Running {!…}'

/** A prompt as it goes: its images, and its text with the `{!cmd}`s run. */
export interface Expanded {
  images: Image[]
  text: string
}

/** What an expansion reaches of the app. */
export interface ExpandHost {
  readonly gw: Requester
  readonly transcript: { notice(text: string, tone?: NoticeEntry['tone']): void }
  /** Puts a prompt that did not go back into the composer. */
  restore(prompt: Prompt): void
  /** Asks for a render. */
  changed(): void
}

/**
 * Whether typed `prompt` has `{!cmd}`s to run, none of those it pasted counted. A plain check, not
 * a type guard: a typed prompt without one is still typed, so callers narrow on `kind` first.
 */
export function hasCommands(prompt: TypedPrompt): boolean {
  return typedCommands(prompt.text, prompt.pasted).length > 0
}

/**
 * `prompt` with its `{!cmd}`s run in session `sid` (the prompt itself when it has none); undefined
 * when one failed, after the notice says so and the prompt is back in the composer.
 */
export async function expand(host: ExpandHost, sid: LiveSessionId, prompt: Prompt): Promise<Expanded | undefined> {
  if (prompt.kind !== 'typed' || !hasCommands(prompt)) {
    return prompt
  }

  try {
    return { images: prompt.images, text: await interpolate(host.gw, sid, prompt.text, prompt.pasted) }
  } catch (error) {
    host.transcript.notice(`Not sent: a {!…} command failed: ${shellError(error)}.`, 'error')
    host.restore(prompt)
    host.changed()

    return undefined
  }
}
