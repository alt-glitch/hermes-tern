// Dictation in the dock, while `/voice on` holds: the mic on the composer's bar, and above the
// editor the capture's row: what the microphone is doing, what the STT has heard so far (a
// streaming provider only), and Done and Cancel.

import type { JSX } from '@stencil-hq/tern'

import type { DictationPhase } from '../draft/dictation.js'

import { button } from './ui/button.js'
import { shimmerText } from './ui/live.js'

/** Dictation as the dock draws it; none while it is off. */
export interface DictationView {
  readonly phase: Exclude<DictationPhase, 'off'>
  /** What the STT has heard of the capture so far. */
  readonly heard: string
  /** The record key, as /help writes it (`alt+v`). */
  readonly key: string
}

/** What the mic and the capture's buttons do. */
export interface DictationActions {
  onDictate(): void
  onDictationDone(): void
  onDictationCancel(): void
}

const LABEL: Record<Exclude<DictationPhase, 'off' | 'ready'>, string> = {
  listening: 'Listening…',
  starting: 'Opening the microphone…',
  transcribing: 'Writing it down…'
}

/** The mic on the composer's bar: muted while ready, red while a capture is in flight. */
export function micButton(d: DictationView, on: DictationActions): JSX.Element {
  const live = d.phase !== 'ready'

  return (
    <icon
      key="mic"
      name="mic"
      onClick={on.onDictate}
      role="hermes.composer.mic"
      title={live ? `Dictating · ${d.key} or ⏎ ends it, esc cancels` : `Dictate  ${d.key}`}
      tone={live ? 'error' : 'muted'}
    />
  )
}

/** The capture's row above the editor; none while no capture is in flight. */
export function dictationRow(d: DictationView, on: DictationActions): JSX.Element | null {
  if (d.phase === 'ready') {
    return null
  }

  return (
    <row align="center" gap="sm" key="dictation" role="hermes.dictation">
      <icon key="mic" name="mic" tone="error" />
      {shimmerText({ key: 'state', role: 'hermes.dictation.state', text: LABEL[d.phase] })}
      {d.heard ? <text key="heard" role="hermes.dictation.heard" spans={[{ s: 'dim', t: d.heard }]} /> : null}
      <spacer grow={1} key="fill" />
      {d.phase === 'transcribing' ? null : button({ hint: d.key, key: 'done', keys: d.key.split('+'), label: 'Done', onClick: on.onDictationDone })}
      {button({ hint: 'esc', key: 'cancel', keys: ['esc'], label: 'Cancel', onClick: on.onDictationCancel })}
    </row>
  )
}
