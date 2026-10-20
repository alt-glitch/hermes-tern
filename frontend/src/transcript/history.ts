// A resumed session's entries, rebuilt from its stored messages: prompts, turns of thoughts,
// text and tool calls, the notices Hermes wrote itself, and the compactions the gateway's history
// leaves out, placed where they happened.

import type { TranscriptMessage } from '@hermes/shared/gateway-events'

import { settleBridge, unwrap } from '../bridge.js'
import { type EntryId, type ToolCallId, toolCallId } from '../core/ids.js'
import type { Entry, Todo, ToolCall, TurnEnd, TurnEntry, UserEntry } from '../model.js'
import { promptAttachments, splitPrompt } from '../promptRefs.js'
import { parseJson, record } from '../wire/json.js'
import { isTodoName } from './calls.js'
import type { RestoredCompaction } from './compactions.js'
import { continuation, displayNotice, failure, internalNotice, passable, steerText, userEntry } from './messages.js'
import { todosOf } from './todos.js'
import { turnEndedAt } from './turns.js'

/** What a reload reads. */
export interface HistorySource {
  /** The entries a reload keeps (the welcome card): the rebuilt ones follow them. */
  kept: Entry[]
  messages: TranscriptMessage[]
  /** The stored compactions, oldest first (Compactions.restore). */
  compactions: readonly RestoredCompaction[]
  /** A fresh id for an entry or block, unique within the transcript. */
  id: (prefix: string) => EntryId
}

/**
 * The entries of a resumed session: `kept`, then what its stored messages make, with its
 * compactions where they happened: in the turn that went on after one, else between turns.
 */
export function history({ kept, messages, compactions, id }: HistorySource): Entry[] {
  const entries = [...kept]
  let turn: TurnEntry | undefined
  const marks = [...compactions]
  let due: RestoredCompaction[] = []

  const place = (inTurn: boolean) => {
    for (const { at, compaction } of due) {
      if (inTurn && turn) {
        turn.blocks.push({ at, compaction, id: id('z'), kind: 'compaction' })
      } else {
        entries.push({ compaction, id: id('z'), kind: 'compaction', rev: 0 })
      }
    }

    due = []
  }
  let pendingContinued: string | undefined
  // When the row that opened the next turn (a prompt or a notice) was written.
  let promptAt = 0
  const calls = new Map<ToolCallId, ToolCall>()
  // The list as the calls so far left it: what the next merge patches.
  let todos: Todo[] | undefined

  for (const m of messages) {
    const at = typeof m.timestamp === 'number' ? m.timestamp * 1000 : 0
    const text = typeof m.text === 'string' ? m.text : typeof m.content === 'string' ? m.content : ''

    // A steer is stored as its own user row inside the turn it joined. The display projection
    // tags it `steer` and already unwraps Hermes' marker; a raw snapshot still carries the marker.
    const steered = m.role === 'user' ? (m.display_kind === 'steer' ? text.trim() : steerText(text)) : undefined

    while (at > 0 && marks[0] && marks[0].at <= at) {
      due.push(marks[0])
      marks.shift()
    }

    // The turn going on after it (its next step or a steer) holds it; a prompt or a notice starts afresh.
    place(m.role === 'assistant' || m.role === 'tool' || (m.role === 'user' && steered !== undefined))

    if (steered !== undefined && turn) {
      turn.blocks.push({ at, id: id('s'), kind: 'steer', text: steered })

      continue
    }

    if (m.role === 'user') {
      turn = undefined
      promptAt = at

      // Notices Hermes sends itself (subagents or a background command finished, a watcher
      // fired, a crashed turn resumed) are not the user's words: they become the next turn's
      // reason line. Typed rows say so in display_kind; older untyped rows are sniffed.
      const notice = displayNotice(m.display_kind, m.display_metadata) ?? internalNotice(text)

      if (notice) {
        pendingContinued = notice
      } else {
        // A notice whose reply Hermes hid has no turn: its reason must not fall on this prompt's.
        pendingContinued = undefined
        entries.push(storedUser(id('u'), steered ?? text, at))
      }

      continue
    }

    if (m.role === 'system') {
      turn = undefined

      if (text.trim()) {
        entries.push({ id: id('n'), kind: 'notice', text, tone: 'info' })
      }

      continue
    }

    if (!turn) {
      const continued = pendingContinued ?? continuation(entries.findLast(passable))
      turn = { blocks: [], continued, end: { status: 'done' }, id: id('t'), kind: 'turn', rev: 0, startedAt: promptAt || at }
      pendingContinued = undefined
      promptAt = 0
      entries.push(turn)
    }

    // The turn ended with its last stored row (the footer and the fold's duration read it).
    const end = turn.end

    if (at > 0 && end.status !== 'live') {
      turn.end = { ...end, endedAt: Math.max(end.endedAt ?? at, at) }
    }

    if (m.role === 'assistant') {
      const meta = record(m.display_metadata)
      const thought = storedThought(m)

      if (thought.trim()) {
        turn.blocks.push({ endedAt: at, id: id('k'), kind: 'thinking', startedAt: at, text: thought })
      }

      // Hermes' own row closing a failed turn: the turn's error card, not the agent's answer.
      if (m.display_kind === 'failed_turn') {
        const surface = record(meta?.['error_surface'])
        const error = str(meta?.['error']) ?? str(surface?.['message'])
        // A row with no error keeps the one an earlier row of the turn gave.
        const card = error ? failure(error, surface?.['code']) : turn.end.status === 'error' ? turn.end : {}
        endTurn(turn, { ...card, hint: text.trim() || undefined, status: 'error' })

        continue
      }

      // The commentary projection: interim messages apart, and a reply with raw commentary cleaned.
      const reply = typeof m['display_content'] === 'string' ? m['display_content'] : text
      const notes = Array.isArray(m['display_commentary'])
        ? m['display_commentary'].filter((n): n is string => typeof n === 'string' && Boolean(n.trim()))
        : []
      const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

      // Some providers store the joined commentary as the reply too: keep that copy once.
      if (!reply.trim() || flat(notes.join('\n\n')) !== flat(reply)) {
        turn.blocks.push(...notes.map(n => ({ id: id('x'), kind: 'text' as const, text: n })))
      }

      if (reply.trim()) {
        turn.blocks.push({ id: id('x'), kind: 'text', text: reply })
      }

      // A reply the user stopped halfway is stored as far as it got.
      if (meta?.['interrupted'] === true) {
        endTurn(turn, { status: 'interrupted' })
      }
    } else if (m.role === 'tool') {
      // A stored row with no call id gets an entry id in its place, unique in this transcript.
      const callId = toolCallId(m.tool_call_id ?? id('c'))
      // History keeps the result only for edit tools (`content`, JSON); the rest come back bare.
      const result = typeof m.content === 'string' && m.content ? m.content : undefined
      // The edit preview the live call showed (tool.complete's inline_diff), kept on the row.
      const diff = str(record(record(m.display_metadata)?.['tool_result_metadata'])?.['inline_diff'])
      const existing = calls.get(callId)

      if (existing) {
        existing.result = result ?? existing.result
        existing.diff = diff ?? existing.diff

        if (settleBridge(existing)) {
          existing.outcome = { duration: 0, kind: 'error' }
        }

        continue
      }

      // Deferred tools (todo_list, connectors, …) are stored as the `tool_call` bridge that ran them.
      const u = unwrap(m.name ?? 'tool', m.args ?? {})
      const args = u.args

      const call: ToolCall = {
        args,
        argsText: '',
        context: m.context ?? '',
        diff,
        id: callId,
        name: u.name,
        outcome: { duration: 0, kind: 'done' },
        result,
        startedAt: at,
        via: u.via
      }

      call.outcome = { duration: 0, kind: (settleBridge(call) ?? Boolean(record(call.result)?.['error'])) ? 'error' : 'done' }

      if (isTodoName(call.name)) {
        call.todosBefore = todos
      }

      // History drops todo results: the list is the stored args, a merge patching the one before.
      if (Array.isArray(args['todos'])) {
        call.todos = todosOf(args, todos)
        todos = call.todos
      }

      calls.set(callId, call)
      turn.blocks.push({ call, id: id('c'), kind: 'tool' })
    }
  }

  due.push(...marks)
  place(false)

  return entries
}

/** A stored prompt: its words, and as attachments the image refs and attached context Hermes stored with them. */
export function storedUser(id: EntryId, raw: string, at: number): UserEntry {
  const parts = splitPrompt(raw)

  return userEntry(id, { at, attachments: promptAttachments(parts), text: parts.text })
}

/** Ends stored turn `turn` as `end`, still at the time its rows gave so far (if any). */
function endTurn(turn: TurnEntry, end: Exclude<TurnEnd, { status: 'live' }>) {
  const at = turnEndedAt(turn)

  turn.end = at === undefined ? end : { ...end, endedAt: at }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

/**
 * A stored reply's thinking, as the desktop reads it (chat-messages/hydration.ts): the projection's
 * `display_reasoning` (commentary taken out), else whichever field the provider kept it in.
 */
function storedThought(m: TranscriptMessage): string {
  if (typeof m['display_reasoning'] === 'string') {
    return detailsText(m['display_reasoning'])
  }

  return str(m.reasoning) ?? str(m['reasoning_content']) ?? detailsText(m['reasoning_details'])
}

/**
 * The readable text of stored `reasoning_details`: each provider block's summary, thinking or
 * text. Encrypted blocks are opaque replay data; plain text (not JSON) is the thought itself.
 */
function detailsText(details: unknown): string {
  let blocks = details

  if (typeof blocks === 'string') {
    const text = blocks.trim()

    if (!text.startsWith('[') && !text.startsWith('{')) {
      return text
    }

    blocks = parseJson(text)

    if (blocks === undefined) {
      return text
    }
  }

  const out: string[] = []

  for (const block of Array.isArray(blocks) ? blocks : [blocks]) {
    const r = typeof block === 'string' ? { text: block } : record(block)

    if (!r || r['type'] === 'reasoning.encrypted') {
      continue
    }

    // OpenAI Responses keeps a summary as parts ({type: 'summary_text', text}).
    const summary = Array.isArray(r['summary'])
      ? r['summary'].map(s => (typeof s === 'string' ? s : (str(record(s)?.['text']) ?? ''))).join('\n\n')
      : r['summary']
    const text = [summary, r['thinking'], r['content'], r['text']].map(str).find(Boolean)?.trim()

    if (text && !out.includes(text)) {
      out.push(text)
    }
  }

  return out.join('\n\n')
}
