// How a subagent's status looks, everywhere one is drawn: the hub's dot and its Status fact, the
// word for it, and the state of its Tern `agent` row.

import type { AgentStatus, Tone } from '@stencil-hq/tern'

import type { Subagent } from '../model.js'

/** The look of one status. */
export interface SubagentLook {
  /** The hub row's dot, and the Status fact's span style. */
  tone: Tone
  /** The status as the hub names it. */
  word: string
  /** The `agent` row's status. */
  row: AgentStatus
}

/** Each subagent status's look. */
export const SUBAGENT_LOOK = {
  cancelled: { row: 'aborted', tone: 'warning', word: 'Stopped' },
  done: { row: 'done', tone: 'success', word: 'Done' },
  failed: { row: 'failed', tone: 'error', word: 'Failed' },
  queued: { row: 'pending', tone: 'muted', word: 'Queued' },
  running: { row: 'running', tone: 'accent', word: 'Running' }
} as const satisfies Record<Subagent['status'], SubagentLook>
