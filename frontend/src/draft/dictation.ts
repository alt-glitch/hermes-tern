// Dictation: the user speaks, and Hermes' own speech-to-text writes the words into the composer at
// the caret, as one undo step. It stays off until `/voice on`, and the microphone opens only when
// the record key (config.yaml's `voice.record_key`, else Alt+V) is pressed. The
// same key, Enter or Done ends the capture; Esc, Ctrl+C or Cancel throws it away. Nothing it writes
// is ever sent: the user reads the draft and sends it.

import type { Key } from '@stencil-hq/tern'

import { errorText } from '../core/errors.js'
import { type Capture, type Recorder, recordKey } from '../hermes/dictation.js'
import type { NoticeEntry } from '../model.js'
import type { DictationEvent } from '../wire/files.js'

import type { Composer } from './composer.js'
import { type KeyMatch, matches } from './keys.js'

/**
 * Off until `/voice on`; ready for the record key; then one capture: the helper starting, the
 * microphone open, and the capture being written down.
 */
export type DictationPhase = 'off' | 'ready' | 'starting' | 'listening' | 'transcribing'

/** What dictation reaches of the app. */
export interface DictationHost {
  readonly composer: Pick<Composer, 'selection' | 'splice' | 'text'>
  note(text: string, tone?: NoticeEntry['tone']): void
  changed(): void
}

/** The pane's dictation: its phase, what the STT has heard so far, and the capture in flight. */
export class Dictation {
  readonly #host: DictationHost
  readonly #recorder: Recorder | undefined
  #phase: DictationPhase = 'off'
  #heard = ''
  #key: KeyMatch = recordKey(undefined)
  /** The capture in flight: lines from any other (one cancelled, one before it) are dropped. */
  #capture: Capture | undefined
  /** The last capture's helper until it exits: a new one waits for the microphone. */
  #closing: Promise<void> | undefined
  /** The capture in flight wrote text. */
  #wrote = false

  constructor(host: DictationHost, recorder: Recorder | undefined) {
    this.#host = host
    this.#recorder = recorder
  }

  get phase(): DictationPhase {
    return this.#phase
  }

  /** What a streaming STT provider has heard of the capture so far; shown, never written. */
  get heard(): string {
    return this.#heard
  }

  /** The record key. */
  get key(): KeyMatch {
    return this.#key
  }

  /** A capture is in flight. */
  get capturing(): boolean {
    return this.#phase === 'starting' || this.#phase === 'listening' || this.#phase === 'transcribing'
  }

  /**
   * `/voice on`: checks the microphone and the STT provider, then arms the record key
   * (`rawKey`: config.yaml's `voice.record_key`). True when dictation is on.
   */
  async enable(rawKey: unknown): Promise<boolean> {
    if (!this.#recorder) {
      this.#host.note('Dictation runs in Hermes’ interpreter, which only `hermes tern` names (HERMES_PYTHON).', 'warning')

      return false
    }

    const found = await this.#recorder.check()

    if ('error' in found) {
      this.#host.note(`Dictation is unavailable: ${found.error}`, 'error')
    } else if (!found.ready) {
      this.#host.note(`Dictation is not set up on this machine.\n${found.details}`, 'warning')
    } else {
      this.#key = recordKey(rawKey)

      if (this.#phase === 'off') {
        this.#phase = 'ready'
      }

      this.#host.note(`Dictation on. ${this.#key.label} starts and ends a capture, esc cancels it. The words go into the composer; nothing is sent until you send it.`)
    }

    this.#host.changed()

    return this.#phase !== 'off'
  }

  /** `/voice off`: drops any capture and leaves the record key to the composer. */
  disable() {
    this.cancel()
    this.#phase = 'off'
    this.#host.changed()
  }

  /** The record key, the mic button: starts a capture, or ends the one that listens. */
  toggle() {
    if (this.#phase === 'ready') {
      this.#start()
    } else if (this.#phase === 'starting' || this.#phase === 'listening') {
      this.finish()
    }
  }

  /** Ends the capture; its words follow. */
  finish() {
    if (this.#capture && this.#phase !== 'transcribing') {
      this.#capture.stop()
      this.#phase = 'transcribing'
      this.#host.changed()
    }
  }

  /** Throws the capture away; false when there was none. */
  cancel(): boolean {
    const capture = this.#capture

    if (!capture) {
      return false
    }

    capture.cancel()
    this.#end()

    return true
  }

  /** The key rule: the record key while dictation is on, and Esc while a capture is in flight. */
  onKey(key: Key): boolean {
    if (this.#phase === 'off') {
      return false
    }

    if (matches(key, this.#key)) {
      this.toggle()

      return true
    }

    const bareEsc = key.name === 'escape' && !key.ctrl && !key.alt && !key.meta && !key.shift

    return bareEsc && this.cancel()
  }

  /** The pane closes: the helper releases the microphone. */
  dispose() {
    this.cancel()
  }

  #start() {
    const recorder = this.#recorder

    if (!recorder) {
      return
    }

    if (this.#closing) {
      this.#host.note('The microphone is still closing from the last capture. Try again in a moment.', 'warning')

      return
    }

    let capture: Capture | undefined

    try {
      capture = recorder.start(event => this.#on(capture, event))
    } catch (error) {
      this.#host.note(`Dictation failed: ${errorText(error)}`, 'error')

      return
    }

    const closing = capture.closed.then(() => {
      if (this.#closing === closing) {
        this.#closing = undefined
      }
    })

    this.#capture = capture
    this.#closing = closing
    this.#phase = 'starting'
    this.#wrote = false
    this.#host.changed()
  }

  #on(capture: Capture | undefined, event: DictationEvent) {
    if (!capture || capture !== this.#capture) {
      return
    }

    switch (event.kind) {
      case 'state':
        if (event.state === 'idle') {
          if (!this.#wrote && this.#phase === 'transcribing') {
            this.#host.note('Dictation heard nothing.')
          }

          this.#end()
        } else if (this.#phase !== 'transcribing') {
          // A stop already asked for the words: a `listening` sent before it does not reopen the row.
          this.#phase = event.state
        }

        break

      case 'partial':
        this.#heard = event.text
        break

      case 'text':
        this.#write(event.text)
        break

      case 'error':
        this.#host.note(`Dictation failed: ${event.message}`, 'error')
        capture.cancel()
        this.#end()
        break
    }

    this.#host.changed()
  }

  /** `text` at the caret (over a selection), spaced from the words beside it, as one undo step. */
  #write(text: string) {
    const words = text.trim()

    if (!words) {
      return
    }

    const { composer } = this.#host
    const [from, to] = composer.selection
    const before = composer.text.slice(0, from)
    const after = composer.text.slice(to)
    const inserted = `${before && !/\s$/.test(before) ? ' ' : ''}${words}${after && !/^\s/.test(after) ? ' ' : ''}`

    composer.splice(from, to, inserted)
    this.#wrote = true
  }

  #end() {
    this.#capture = undefined
    this.#heard = ''

    if (this.#phase !== 'off') {
      this.#phase = 'ready'
    }

    this.#host.changed()
  }
}
