// Tern SDK 0.1.0 collapses CSI-u press, repeat and release into identical Keys.
// Never infer release by timeouts, TSP focus/visible or guessed pointer events.
import type { Key } from '@stencil-hq/tern'

export const HOLD_UNAVAILABLE =
  'Hold-to-talk unavailable: this Tern SDK does not expose reliable key-down/key-up events. ' +
  'Use Mic / Alt+V from dictation PR #71 to start/finish review-only capture; Esc discards. ' +
  'Alt+Shift+Space only displays this message and never opens a microphone.'

/** Explicit duplex-call start/stop; never matches modified variants. */
export const isTalkToggleKey = (key: Key): boolean =>
  key.name === 'l' && key.ctrl && !key.alt && !key.meta && !key.shift

/** The voice toggle belongs to the app even when profile shortcuts are configured. */
export const isVoiceToggleKey = (key: Key): boolean =>
  key.name === 'v' && key.alt && key.shift && !key.ctrl && !key.meta

/** This chord is information only; normal Space and repeats belong to the editor. */
export const isHoldInfoKey = (key: Key): boolean =>
  key.name === 'space' && key.alt && key.shift && !key.ctrl && !key.meta
