// Finding tool calls in a transcript's entries, and what kind of call one is: a todo call, one
// that starts or watches a background process, or one that failed. A search goes newest first,
// so a repeated tool id names the newest call that has it.

import type { ToolCompletePayload } from '@hermes/shared/gateway-events'

import type { Block, Entry, ToolCall, TurnEntry } from '../model.js'
import { record } from '../wire/json.js'

type ToolBlock = Extract<Block, { kind: 'tool' }>

/** A tool call and the turn holding it (whose revision a change to the call bumps). */
export interface Located {
  call: ToolCall
  turn: TurnEntry
}

/** The newest call matching `match` in any turn of `entries`, newest turn first. */
export function findCall(entries: readonly Entry[], match: (call: ToolCall) => boolean): Located | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const turn = entries[i]

    if (turn?.kind !== 'turn') {
      continue
    }

    const located = callIn(turn, match)

    if (located) {
      return located
    }
  }

  return undefined
}

/** The newest call matching `match` in `turn` only. */
export function callIn(turn: TurnEntry, match: (call: ToolCall) => boolean): Located | undefined {
  const hit = turn.blocks.findLast((b): b is ToolBlock => b.kind === 'tool' && match(b.call))

  return hit && { call: hit.call, turn }
}

/** The calls in `entries` that `match` takes, oldest first. */
export function callsWhere(entries: readonly Entry[], match: (call: ToolCall) => boolean): ToolCall[] {
  return entries.flatMap(e => (e.kind === 'turn' ? e.blocks.flatMap(b => (b.kind === 'tool' && match(b.call) ? [b.call] : [])) : []))
}

/** The task tool's names: `todo_list`, and `todo`, the legacy alias in stored transcripts. */
export function isTodoName(name: string): boolean {
  return name === 'todo_list' || name === 'todo'
}

/** The tool that manages background processes: `process_manage`, `process` before Hermes renamed it. */
export function isProcessTool(name: string): boolean {
  return name === 'process_manage' || name === 'process'
}

/** A process tool call that waits on, polls or reads one background process (omp's `wait`). */
export function isWatchCall(call: ToolCall): boolean {
  return isProcessTool(call.name) && ['log', 'poll', 'wait'].includes(String(call.args.action)) && typeof call.args.session_id === 'string'
}

/**
 * A terminal call that started a background process: `background: true`, or a foreground call
 * Hermes moved to the background (a long timeout, a message arriving mid-run), whose result
 * then names the process (`session_id`).
 */
export function isBackgroundCall(call: ToolCall): boolean {
  return call.name === 'terminal' && (call.args.background === true || typeof record(call.result)?.session_id === 'string')
}

/** A completed call that failed: an error result, a terminal command's nonzero exit, or a summary that says so. */
export function isToolError(p: ToolCompletePayload): boolean {
  const r = record(p.result)

  if (r?.error) {
    return true
  }

  if (p.name === 'terminal' && typeof r?.exit_code === 'number' && r.exit_code !== 0) {
    return true
  }

  return typeof p.summary === 'string' && /^(error|failed)\b/i.test(p.summary)
}
