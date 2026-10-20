// The turn as it streams: its start, text, reasoning and Mixture-of-Agents steps, its tool calls,
// the todo list, its end, and the status lines (retries, compaction) that label the working line.

import type { Agents } from '../../agents/store.js'
import { toolCallId } from '../../core/ids.js'
import type { PullRequests } from '../../github/store.js'
import type { ToolCall } from '../../model.js'
import type { SessionState } from '../../session/state.js'
import { statusEffect } from '../../status.js'
import type { Compactions } from '../../transcript/compactions.js'
import type { Transcript } from '../../transcript/store.js'
import type { Activity } from '../../turn/activity.js'
import { afterMessageComplete, afterToolComplete, type MessageFanout, type ToolFanout } from '../../turn/fanout.js'
import type { PromptQueue } from '../../turn/queue.js'
import type { EventOf, Handlers, Outcome } from '../dispatch.js'
import { moaLabel, moaReferenceLabel } from '../moa.js'

import type { Warned } from './chrome.js'

/** What the turn's events reach of the app. */
export interface TurnCx extends ToolFanout, MessageFanout {
  readonly transcript: Pick<
    Transcript,
    | 'call'
    | 'calls'
    | 'complete'
    | 'interim'
    | 'messageStart'
    | 'notice'
    | 'reasoning'
    | 'reasoningBlock'
    | 'reference'
    | 'text'
    | 'todos'
    | 'toolComplete'
    | 'toolStart'
  > & { readonly compactions: Pick<Compactions, 'compacted' | 'compacting' | 'uncompact'> }
  readonly activity: Pick<Activity, 'endBusy' | 'endCompaction' | 'relabel' | 'turnStarted'>
  readonly agents: Pick<Agents, 'scan' | 'settle'>
  readonly prs: Pick<PullRequests, 'onCall' | 'poke' | 'relink'>
  readonly session: Pick<SessionState, 'usage'>
  readonly queue: { readonly server: Pick<PromptQueue['server'], 'settlesQueuedRow'> }
  /** The backend warnings shown already. */
  readonly warned: Warned
  /** The working line's words for a call (view/workLogModel.ts): one that just started, and one the model still writes. */
  readonly labels: { busy(call: ToolCall): string; preparing(name: string): string }
  /** A compaction started or ended; prompts held behind one go once it ends. */
  setCompacting(on: boolean): void
  /** Gives the compactions seen here their summaries from the store, `delay` ms from now. */
  summarize(delay?: number): void
  /** Asks for a render. */
  changed(): void
}

/** `( •_•)>⌐■-■ cogitating...` → `Cogitating…`: hermes's kawaii status without the face. */
export function kaomojiLabel(text: string): string {
  const word = text.match(/([A-Za-z][A-Za-z ]*[A-Za-z])\.{2,}\s*$/)?.[1]

  return word ? `${word.charAt(0).toUpperCase()}${word.slice(1)}…` : ''
}

/** A Mixture-of-Agents step: the working line says which. */
function moaStep(ev: EventOf<'moa.aggregating' | 'moa.phase' | 'moa.progress'>, cx: TurnCx): Outcome {
  cx.activity.relabel(moaLabel(ev) ?? '')

  return 'render'
}

/** The turn's events. */
export const turnHandlers = {
  'message.start': (ev, cx) => {
    // The turn owns the working row from here: a send's late answer no longer ends it.
    cx.activity.turnStarted()

    cx.transcript.messageStart()

    // A delegation's completion turn carries its model text: each task's outcome, which a log
    // this process cannot read (a remote gateway) never told.
    if (ev.payload?.display_kind === 'async_delegation_complete' && ev.payload.text) {
      cx.agents.settle(ev.payload.text)
    }

    return 'render'
  },

  'message.delta': (ev, cx) => {
    cx.transcript.text(ev.payload?.text ?? '')
    cx.activity.relabel('Writing…')

    return 'render'
  },

  'reasoning.delta': (ev, cx) => {
    cx.transcript.reasoning(ev.payload?.text ?? '')
    cx.activity.relabel('Thinking…')

    return 'render'
  },

  'reasoning.available': (ev, cx) => {
    cx.transcript.reasoningBlock(ev.payload?.text ?? '')

    return 'render'
  },

  // Mixture-of-Agents: each reference model's answer, then the aggregator's turn.
  'moa.reference': (ev, cx) => {
    if (ev.payload) {
      cx.transcript.reference(moaReferenceLabel(ev.payload.label || 'reference', ev.payload.index, ev.payload.count), ev.payload.text ?? '')
    }

    return 'render'
  },

  'moa.progress': moaStep,
  'moa.phase': moaStep,
  'moa.aggregating': moaStep,

  'thinking.delta': (ev, cx) => {
    cx.activity.relabel(kaomojiLabel(ev.payload?.text ?? ''))

    return 'render'
  },

  'message.interim': (ev, cx) => {
    cx.transcript.interim(ev.payload?.text ?? '', { alreadyStreamed: Boolean(ev.payload?.already_streamed) })

    return 'render'
  },

  'tool.generating': (ev, cx) => {
    cx.activity.relabel(ev.payload?.name ? cx.labels.preparing(ev.payload.name) : 'Preparing a tool…')

    return 'render'
  },

  'tool.start': (ev, cx) => {
    if (ev.payload) {
      cx.transcript.toolStart(ev.payload)
      // The call as its step reads (a bridged or connector call as its app), not its wire name.
      const call = cx.transcript.call(toolCallId(ev.payload.tool_id))
      cx.activity.relabel(call ? cx.labels.busy(call) : `Running ${ev.payload.name}…`)
      // vision_analyze names its image up front.
      cx.showImage(call)
    }

    return 'render'
  },

  'tool.complete': (ev, cx) => {
    if (ev.payload) {
      cx.transcript.toolComplete(ev.payload)
      afterToolComplete(ev.payload, cx)
    }

    return 'render'
  },

  'todo.updated': (ev, cx) => {
    cx.transcript.todos(ev.payload?.todos ?? [])

    return 'render'
  },

  'message.complete': (ev, cx) => {
    // prompt.cancel settles a withdrawn queued row with a completion of its own.
    if (cx.queue.server.settlesQueuedRow(ev.payload)) {
      return 'quiet'
    }

    afterMessageComplete(ev.payload ?? {}, cx)

    return 'render'
  },

  'status.update': (ev, cx) => {
    // Lifecycle lines (retries, fallbacks) label the working line; warnings, compaction and goal
    // verdicts are transcript lines.
    const effect = statusEffect(ev.payload, cx.warned.status)

    if (effect.compacting !== undefined) {
      cx.setCompacting(effect.compacting)
    }

    if (effect.compacting) {
      cx.transcript.compactions.compacting({ before: effect.tokens?.before ?? (cx.session.usage?.context_used || undefined) })
    } else if (effect.compacting === false) {
      cx.transcript.compactions.compacted(Date.now(), effect.tokens)
      // The store has the summary once the compaction commits (a moment after its done edge).
      cx.summarize(1500)
    }

    if (effect.label) {
      cx.activity.relabel(effect.label, { status: true })
    }

    if (effect.notice) {
      cx.warned.status = effect.note ?? cx.warned.status
      cx.transcript.notice(effect.notice.text, effect.notice.tone)
    }

    return 'render'
  }
} satisfies Handlers<TurnCx>
