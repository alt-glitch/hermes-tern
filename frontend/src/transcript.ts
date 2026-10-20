// Folds gateway events into the structured transcript (model.ts). One live
// turn at a time: message.start opens it, message.complete closes it, and
// reasoning, text and tool events land in its blocks in arrival order.
// Compactions (transcript/compactions.ts) and a reload from history
// (transcript/history.ts) are parts of their own.

import type {
  InflightTurn,
  MessageCompletePayload,
  ToolCompletePayload,
  ToolStartPayload,
  TranscriptMessage,
  Usage
} from '@hermes/shared/gateway-events'

import { nextVia, settleBridge, unwrap } from './bridge.js'
import type { StoredCompaction } from './compaction.js'
import { type EntryId, entryId, type ToolCallId, toolCallId } from './core/ids.js'
import type { Compaction, Counters, Entry, NoticeEntry, Todo, ToolCall, TurnEntry, UserAttachment } from './model.js'
import { callIn, callsWhere, findCall, isBackgroundCall, isTodoName, isToolError, isWatchCall, type Located } from './transcript/calls.js'
import { type CompactionStart, Compactions } from './transcript/compactions.js'
import { history, storedUser } from './transcript/history.js'
import { continuation, displayNotice, failure, internalNotice, passable, type UserPrompt, userEntry } from './transcript/messages.js'
import { currentTodos, todosOf, toTodos } from './transcript/todos.js'
import { endThinking, shownArgs, trailingText, usageSince } from './transcript/turns.js'
import { withoutTernEnv } from './view/describe.js'
import { record } from './wire/json.js'

/** The ordered entries of one session, plus the event reducer that grows them. */
export class Transcript {
  #entries: Entry[] = []
  #next = 0
  /** The session's running usage at the last completed turn (message.complete reports session totals). */
  #sessionUsage: Usage | undefined
  /** The session's cumulative counters at the last `session.usage` tick. */
  #counters: Counters | undefined
  /** The streaming turn: set by start, cleared by complete, reset and load (notices may land after it). */
  #live: TurnEntry | undefined
  /** The reason line for the next turn, when Hermes' own notice started it. */
  #continued: string | undefined
  /**
   * The turn complete() closed last, until another opens: a reasoning block or a tool result that
   * comes after it lands there, and opens no live turn of its own.
   */
  #ended: TurnEntry | undefined
  readonly #compactions = new Compactions({ entries: () => this.#entries, id: prefix => this.id(prefix), live: () => this.#live })

  /** The entries, oldest first; only the transcript's own methods change the list. */
  get entries(): readonly Entry[] {
    return this.#entries
  }

  /**
   * Starts over for an adopted session, in one step: only a welcome, no live turn, no reason line
   * waiting, and `usage` (a resumed session's totals) as what turns count from. Another `session`
   * also takes the last one's counters and compactions; a reattach of the same session keeps them
   * (a reload's stored compactions get their numbers from the ones seen).
   */
  reset({ session, usage }: { session: 'other' | 'same'; usage: Usage | undefined }) {
    this.#entries = [{ id: this.id('w'), kind: 'welcome' }]
    this.#live = undefined
    this.#ended = undefined
    this.#continued = undefined
    this.#sessionUsage = usage

    if (session === 'other') {
      this.#counters = undefined
      this.#compactions.forget()
    }
  }

  /**
   * Takes a `session.usage` tick's cumulative counters and rate. The turn running (or, as the
   * last tick can trail message.complete, the one that just ended) gets its share: tokens and
   * the part of its prompt read from the cache.
   */
  usageTick(counters: Counters, tps: number | undefined) {
    this.#counters = counters
    const turn = this.#current()
    let start = turn?.countersAtStart

    if (!turn || !start) {
      return
    }

    // The counters went back: Hermes built a new agent for the session (they are its, not the
    // session's), so the turn counts from zero rather than below it.
    if (counters.total < start.total) {
      start = turn.countersAtStart = { prompt: 0, read: 0, total: 0 }
    }

    const prompt = counters.prompt - start.prompt
    const hit = prompt > 0 ? Math.round(((counters.read - start.read) / prompt) * 100) : undefined
    const tokens = counters.total - start.total || undefined

    if (hit !== turn.cacheHit || tokens !== turn.tickTokens || tps !== turn.tps) {
      turn.cacheHit = hit
      turn.tickTokens = tokens
      turn.tps = tps
      turn.rev++
    }
  }

  /** A fresh id for an entry or block, unique within this transcript. */
  id(prefix: string): EntryId {
    return entryId(`${prefix}${(this.#next++).toString(36)}`)
  }

  get live(): TurnEntry | undefined {
    return this.#live
  }

  push(entry: Entry) {
    this.#entries.push(entry)
  }

  /**
   * A steer the gateway took for the running turn: it shows inside that turn, where it was sent,
   * since the agent reads it before its next step. With no turn running it is a plain prompt.
   */
  steer(text: string, at = Date.now()) {
    const turn = this.live

    if (!turn) {
      return this.user({ at, text })
    }

    turn.blocks.push({ at, id: this.id('s'), kind: 'steer', text })
    turn.rev++
  }

  /** A prompt bubble at the end. */
  user(prompt: UserPrompt) {
    this.push(userEntry(this.id('u'), prompt))
  }

  /**
   * A queued prompt the shared gateway just started. Its message.start came first, so the bubble
   * goes before the turn it opened while that turn is still empty; else at the end.
   */
  started(text: string, at = Date.now(), attachments: UserAttachment[] = []) {
    const live = this.live
    // A goal continuation or loop run Hermes queued itself: a reason line on its turn, not a bubble.
    const notice = attachments.length ? undefined : internalNotice(text)

    if (notice) {
      if (live && !live.blocks.length) {
        live.continued = notice
        live.rev++
      } else {
        this.#continued = notice
      }

      return
    }

    if (live && !live.blocks.length && this.#entries.at(-1) === live) {
      this.#entries.splice(-1, 0, userEntry(this.id('u'), { at, attachments, text }))
      // It answers this prompt; it did not go on on its own.
      live.continued = undefined
      live.rev++

      return
    }

    this.user({ at, attachments, text })
  }

  notice(text: string, tone: NoticeEntry['tone'] = 'info') {
    this.push({ id: this.id('n'), kind: 'notice', text, tone })
  }

  panel(title: string, text: string) {
    this.push({ id: this.id('p'), kind: 'panel', text, title })
  }

  /**
   * The context started compacting (`before`: its tokens, when known). Inside a running turn that
   * already did something it is a step of that turn; else it goes between turns, before the turn
   * it was compacted for. Hermes' later lines of the same compaction only fill in the count.
   */
  compacting(start: CompactionStart = {}): Compaction {
    return this.#compactions.compacting(start)
  }

  /** The running compaction ended (`tokens`: the owner's own counts, when it reports them). */
  compacted(at = Date.now(), tokens: { before?: number | undefined; after?: number | undefined } = {}) {
    this.#compactions.compacted(at, tokens)
  }

  /** A compaction did not happen after all: the one compacting() returned, or (`'running'`) the last one while it runs. */
  uncompact(which: Compaction | 'running') {
    this.#compactions.uncompact(which)
  }

  /** A context reading (tokens in use): the first one under the last compaction's `before` is what it left. */
  contextUsed(used: number) {
    this.#compactions.contextUsed(used)
  }

  /** The compactions seen here that the store has no summary for yet. */
  get unsummarized(): boolean {
    return this.#compactions.unsummarized
  }

  /** Gives each seen compaction the stored summary written while it ran. */
  summarize(stored: readonly StoredCompaction[]) {
    this.#compactions.summarize(stored)
  }

  /** message.start: opens the live turn, unless one is already streaming. */
  messageStart(at = Date.now()): TurnEntry {
    return this.#open(at)
  }

  /**
   * Opens a live turn unless one is already streaming. Only the reducer calls it, and only once
   * the event proved it has something for the turn.
   */
  #open(at: number): TurnEntry {
    const live = this.live

    if (live) {
      return live
    }

    const turn: TurnEntry = {
      blocks: [],
      continued: this.#continued ?? continuation(this.#entries.findLast(passable)),
      // A session's first turn starts from zero; later ones from the last tick.
      countersAtStart: this.#counters ?? (this.#entries.some(e => e.kind === 'turn') ? undefined : { prompt: 0, read: 0, total: 0 }),
      end: { status: 'live' },
      id: this.id('t'),
      kind: 'turn',
      rev: 0,
      startedAt: at
    }
    this.push(turn)
    this.#live = turn
    this.#ended = undefined
    this.#continued = undefined

    return turn
  }

  reasoning(text: string, at = Date.now()) {
    if (!text) {
      return
    }

    const turn = this.#open(at)
    const last = turn.blocks.at(-1)

    if (last?.kind === 'thinking' && last.endedAt === undefined) {
      last.text += text
    } else {
      turn.blocks.push({ id: this.id('k'), kind: 'thinking', startedAt: at, text })
    }

    turn.rev++
  }

  /**
   * A whole reasoning block from a provider that doesn't stream it; ignored once reasoning streamed.
   * Hermes also relays each response's visible text through `reasoning.available`, so text the
   * turn already shows is not a thought either. One that comes after its turn ended goes in that
   * turn.
   */
  reasoningBlock(text: string, at = Date.now()) {
    const shown = this.#live ?? this.#ended
    const incoming = text.trim()

    if (!incoming || shown?.blocks.some(b => (b.kind === 'thinking' && !b.label) || (b.kind === 'text' && b.text.includes(incoming)))) {
      return
    }

    const turn = shown ?? this.#open(at)
    turn.blocks.push({ endedAt: at, id: this.id('k'), kind: 'thinking', startedAt: at, text })
    turn.rev++
  }

  /** A Mixture-of-Agents reference model's answer: a sealed thought block of its own, under `label`. */
  reference(label: string, text: string, at = Date.now()) {
    const turn = this.#open(at)
    endThinking(turn, at)
    turn.blocks.push({ endedAt: at, id: this.id('k'), kind: 'thinking', label, startedAt: at, text: text.trim() })
    turn.rev++
  }

  text(text: string, at = Date.now()) {
    if (!text) {
      return
    }

    const turn = this.#open(at)
    endThinking(turn, at)
    const last = turn.blocks.at(-1)

    if (last?.kind === 'text') {
      last.text += text
    } else {
      turn.blocks.push({ id: this.id('x'), kind: 'text', text })
    }

    turn.rev++
  }

  /** Interim commentary: seals the streamed text so the next delta starts a new block. */
  interim(text: string, { alreadyStreamed }: { alreadyStreamed: boolean }, at = Date.now()) {
    const turn = this.#open(at)
    endThinking(turn, at)

    if (!alreadyStreamed && text.trim()) {
      turn.blocks.push({ id: this.id('x'), kind: 'text', text })
    }

    // An empty text block marks the seal; `text()` appends to a new one after it.
    turn.blocks.push({ id: this.id('x'), kind: 'text', text: '' })
    turn.rev++
  }

  toolStart(p: ToolStartPayload, at = Date.now()) {
    const turn = this.#open(at)
    endThinking(turn, at)

    if (!this.#tool(p.tool_id)) {
      this.#addCall(turn, p, at)
    }
  }

  /** Adds the call tool.start `p` names to `turn`, running. */
  #addCall(turn: TurnEntry, p: ToolStartPayload, at: number) {
    // A bridge call shows as the tool it runs (a connector batch as its entries).
    const u = unwrap(p.name, p.args ?? {})
    const call: ToolCall = {
      args: shownArgs(u.args),
      argsText: p.args_text ?? '',
      context: withoutTernEnv(p.context ?? ''),
      id: toolCallId(p.tool_id),
      name: u.name,
      outcome: { kind: 'running' },
      startedAt: at,
      via: u.via
    }

    const before = this.currentTodos()

    if (isTodoName(call.name)) {
      call.todosBefore = before
    }

    // The call's own list shows while it runs (a merge patches the current one); tool.complete's
    // snapshot replaces it.
    if (Array.isArray(call.args['todos'])) {
      call.todos = todosOf(call.args, before)
    }

    turn.blocks.push({ call, id: call.id, kind: 'tool' })
    turn.rev++
  }

  toolComplete(p: ToolCompletePayload, at = Date.now()) {
    let found = this.#tool(p.tool_id)

    if (!found) {
      // A call never started goes in the live turn; after its turn ended, in that turn (a late
      // result opens none); with neither (a resumed session mid-turn), in a new live turn.
      const turn = this.#live ?? this.#ended ?? this.#open(at)
      endThinking(turn, at)
      this.#addCall(turn, { args: p.args ?? {}, name: p.name, tool_id: p.tool_id }, at)
      found = this.#tool(p.tool_id)
    }

    if (!found) {
      return
    }

    const { call, turn } = found

    const output = record(p.result)?.['output']

    // An interrupted command still completes: hermes marks its output instead of failing it.
    const interrupted =
      p.name === 'terminal' && typeof output === 'string' && /\[Command interrupted\]\s*$/.test(output)

    const duration = typeof p.duration_s === 'number' ? Math.round(p.duration_s * 1000) : at - call.startedAt
    const summary = p.summary ?? undefined
    call.resultText = p.result_text ?? undefined
    call.result = p.result
    call.diff = p.inline_diff ?? undefined

    if (p.args) {
      const u = unwrap(p.name, p.args)
      call.args = shownArgs(u.args)
      call.name = u.name
      call.via = nextVia(call.via, u.via)
    }

    // A connector call's outcome is its entry in the batch result.
    const bridged = settleBridge(call)
    const kind = interrupted ? 'cancelled' : (bridged ?? isToolError(p)) ? 'error' : 'done'
    call.outcome = summary === undefined ? { duration, kind } : { duration, kind, summary }

    if (Array.isArray(p.todos)) {
      call.todos = toTodos(p.todos)
    }

    turn.rev++
  }

  /** The newest todo snapshot lands on the newest todo tool call. */
  todos(todos: unknown[]) {
    const found = this.#lastTool(c => isTodoName(c.name))

    if (found) {
      found.call.todos = toTodos(todos)
      found.turn.rev++
    }
  }

  complete(p: MessageCompletePayload, at = Date.now()) {
    const turn = this.#open(at)
    endThinking(turn, at)
    const final = typeof p.text === 'string' ? p.text : ''
    const tail = trailingText(turn)

    if (final.trim() && tail.trim() !== final.trim() && !(p.status === 'error' && !p.partial)) {
      const last = turn.blocks.at(-1)

      if (last?.kind === 'text') {
        last.text = final
      } else {
        turn.blocks.push({ id: this.id('x'), kind: 'text', text: final })
      }
    }

    turn.blocks = turn.blocks.filter(b => b.kind !== 'text' || b.text.trim())

    for (const b of turn.blocks) {
      if (b.kind === 'tool' && b.call.outcome.kind === 'running') {
        b.call.outcome = { duration: at - b.call.startedAt, kind: p.status === 'error' ? 'error' : p.status === 'interrupted' ? 'cancelled' : 'done' }
      }
    }

    this.#live = undefined
    this.#ended = turn

    if (p.usage) {
      turn.usage = usageSince(p.usage, this.#sessionUsage)
      this.#sessionUsage = p.usage
    }

    turn.warning = p.warning ?? undefined

    if (p.status === 'error') {
      const surfaced = p.error_surface?.['message']
      const error = (typeof surfaced === 'string' && surfaced) || p.error || final || 'The request failed'
      // The gateway's final text is advice ("wait and /retry, or /model …") followed by the raw error.
      const hint = final.split(/\n\s*\n/)[0]?.trim()
      turn.end = { ...failure(error, p.error_surface?.code), endedAt: at, ...(hint ? { hint } : {}), status: 'error' }
    } else {
      turn.end = { endedAt: at, status: p.status === 'interrupted' ? 'interrupted' : 'done' }
    }

    turn.rev++
  }

  /** Seals a live turn the user interrupted before the agent confirmed it. */
  interrupt(at = Date.now()) {
    const turn = this.live

    if (turn) {
      this.complete({ status: 'interrupted' }, at)
    }
  }

  /**
   * Rebuilds the entries of a resumed session from its stored messages, with its compactions
   * (`stored`, which the gateway's history leaves out) where they happened: in the turn that went
   * on after one, else between turns.
   */
  load(messages: TranscriptMessage[], stored: readonly StoredCompaction[] = []) {
    const kept = this.#entries.filter(e => e.kind === 'welcome')
    this.#live = undefined
    this.#ended = undefined
    this.#entries = history({ compactions: this.#compactions.restore(stored), id: prefix => this.id(prefix), kept, messages })
  }

  /** A resumed session's unfinished turn: its prompt, then a live turn holding what streamed so far. */
  inflight(turn: InflightTurn, at = Date.now()) {
    const user = turn.user?.trim()
    const notice = user ? (displayNotice(turn.display_kind, turn.display_metadata) ?? internalNotice(user)) : undefined

    if (notice) {
      this.#continued = notice
    } else if (user) {
      this.push(storedUser(this.id('u'), user, at))
    }

    if (turn.assistant || turn.streaming) {
      this.#open(at)
      this.text(turn.assistant ?? '', at)
    }
  }

  /** Marks the turn holding `call` (if any) changed, after something outside the reducer updated it. */
  touchCall(call: ToolCall | undefined) {
    const found = call && findCall(this.#entries, c => c === call)

    if (found) {
      found.turn.rev++
    }
  }

  /** Changes `call` from outside the reducer (`change` writes it), and marks the turn holding it changed. */
  mutateCall(call: ToolCall, change: (call: ToolCall) => void) {
    change(call)
    this.touchCall(call)
  }

  /** The agent's todo list as its newest snapshot left it (any turn), if it ever made one. */
  currentTodos(): Todo[] | undefined {
    return currentTodos(this.#entries)
  }

  /** The delegate_task calls in the transcript, oldest first. */
  delegations(): ToolCall[] {
    return this.calls('delegate_task')
  }

  /** The calls of tool `name` in the transcript, oldest first. */
  calls(name: string): ToolCall[] {
    return callsWhere(this.#entries, call => call.name === name)
  }

  /** The newest call matching `match` in the live (else the last) turn. */
  lastCall(match: (call: ToolCall) => boolean): ToolCall | undefined {
    return this.#lastTool(match)?.call
  }

  /** The call with tool id `id`, in any turn. */
  call(id: ToolCallId): ToolCall | undefined {
    return this.#tool(id)?.call
  }

  /** The calls that show a background process: terminal calls that start one, `process` calls that watch one; oldest first. */
  backgroundCalls(): ToolCall[] {
    return callsWhere(this.#entries, call => isBackgroundCall(call) || isWatchCall(call))
  }

  /** The call the gateway's tool id `id` names (as an event sends it), in any turn; the newest when ids repeat. */
  #tool(id: string): Located | undefined {
    return findCall(this.#entries, call => call.id === id)
  }

  /** The newest call matching `match` in the live (else the last) turn only. */
  #lastTool(match: (call: ToolCall) => boolean): Located | undefined {
    const turn = this.#current()

    return turn && callIn(turn, match)
  }

  /** The live turn, else the last one. */
  #current(): TurnEntry | undefined {
    return this.live ?? this.#entries.findLast((e): e is TurnEntry => e.kind === 'turn')
  }
}
