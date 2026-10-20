// The pane's input loop: keys and the Tern events no node handler took, read until the session
// closes. Node handlers (a button's onClick) run inside the SDK before anything reaches this loop.

import type { Key, SessionInput, TspEvent } from '@stencil-hq/tern'

/** What the loop calls for each input. */
export interface InputHandlers {
  onKey(key: Key): void
  onEvent(event: TspEvent): void
  /** After each key or event: the pane re-renders. */
  after(): void
  /** The session's input failed (the loop ends); unset, the failure ends it quietly. */
  onError?(error: unknown): void
}

/** Reads `input` until it ends or fails; resolves then, whichever it was. */
export async function runInput(input: AsyncIterable<SessionInput>, { after, onError, onEvent, onKey }: InputHandlers): Promise<void> {
  try {
    for await (const item of input) {
      if (item.type === 'key') {
        onKey(item.key)
      } else {
        onEvent(item.event)
      }

      after()
    }
  } catch (error) {
    onError?.(error)
  }
}
