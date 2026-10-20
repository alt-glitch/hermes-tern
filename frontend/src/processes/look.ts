// How a background process's status looks, everywhere one is drawn: its tone, the icon of an
// ended one, its tile's glyph and the word the Background sheet uses.

import type { BackgroundProcess } from '../model.js'

/** The look of one status. */
export interface ProcessLook {
  /** The palette tone: accent while running, then success, error or warning. */
  tone: 'accent' | 'error' | 'success' | 'warning'
  /** The icon of the process's state (a running one shows a spinner instead). */
  icon: string
  /** The glyph on its tile. */
  glyph: string
  /** The status as the Background sheet names it. */
  word: string
}

/** Each process status's look. */
export const PROCESS_LOOK = {
  done: { glyph: '✓', icon: 'done', tone: 'success', word: 'Exited' },
  failed: { glyph: '✕', icon: 'failed', tone: 'error', word: 'Failed' },
  killed: { glyph: '■', icon: 'aborted', tone: 'warning', word: 'Stopped' },
  lost: { glyph: '■', icon: 'aborted', tone: 'warning', word: 'Lost' },
  running: { glyph: '●', icon: 'running', tone: 'accent', word: 'Running' },
  unknown: { glyph: '?', icon: 'pending', tone: 'warning', word: 'Unknown' }
} as const satisfies Record<BackgroundProcess['status'], ProcessLook>
