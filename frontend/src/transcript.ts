// Folds gateway events into the structured transcript (model.ts). One live
// turn at a time: message.start opens it, message.complete closes it, and
// reasoning, text and tool events land in its blocks in arrival order.

import type {
  InflightTurn,
  MessageCompletePayload,
  SubagentEventPayload,
  ToolCompletePayload,
  ToolStartPayload,
  TranscriptMessage,
  Usage
} from '@hermes/shared/gateway-events'

import type { Block, Entry, NoticeEntry, Todo, ToolCall, TurnEntry } from './model.js'

type ToolBlock = Extract<Block, { kind: 'tool' }>

/** A tool call and the turn holding it (whose revision a change to the call bumps). */
interface Located {
  call: ToolCall
  turn: TurnEntry
}

/** The ordered entries of one session, plus the event reducer that grows them. */
export class Transcript {
  entries: Entry[] = []
  /** Bumped on every change; views and the render loop compare it. */
  rev = 0
  #next = 0
  /** The session's running usage at the last completed turn (message.complete reports session totals). */
  #sessionUsage: Usage | undefined
  /** The streaming turn: set by start, cleared by complete, clear and load (notices may land after it). */
  #live: TurnEntry | undefined

  /** Sets the running usage turns count from (a resumed session's totals). */
  usageBase(usage: Usage | undefined) {
    this.#sessionUsage = usage
  }

  /** A fresh id for an entry or block, unique within this transcript. */
  id(prefix: string): string {
    return `${prefix}${(this.#next++).toString(36)}`
  }

  get live(): TurnEntry | undefined {
    return this.#live
  }

  clear() {
    this.entries = []
    this.#live = undefined
    this.#touch()
  }

  push(entry: Entry) {
    this.entries.push(entry)
    this.#touch()
  }

  user(text: string, at = Date.now()) {
    this.push({ at, id: this.id('u'), kind: 'user', text })
  }

  notice(text: string, tone: NoticeEntry['tone'] = 'info') {
    this.push({ id: this.id('n'), kind: 'notice', text, tone })
  }

  panel(title: string, text: string) {
    this.push({ id: this.id('p'), kind: 'panel', text, title })
  }

  /** Opens a live turn unless one is already streaming. */
  start(at = Date.now()): TurnEntry {
    const live = this.live

    if (live) {
      return live
    }

    const turn: TurnEntry = { blocks: [], id: this.id('t'), kind: 'turn', rev: 0, startedAt: at, status: 'live' }
    this.push(turn)
    this.#live = turn

    return turn
  }

  reasoning(text: string, at = Date.now()) {
    if (!text) {
      return
    }

    const turn = this.start(at)
    const last = turn.blocks.at(-1)

    if (last?.kind === 'thinking' && last.endedAt === undefined) {
      last.text += text
    } else {
      turn.blocks.push({ id: this.id('k'), kind: 'thinking', startedAt: at, text })
    }

    this.#touch(turn)
  }

  /**
   * A whole reasoning block from a provider that doesn't stream it; ignored once reasoning streamed.
   * Hermes also relays each response's visible text through `reasoning.available`, so text the
   * turn already shows is not a thought either.
   */
  reasoningBlock(text: string, at = Date.now()) {
    const turn = this.start(at)
    const incoming = text.trim()

    if (!incoming || turn.blocks.some(b => b.kind === 'thinking' || (b.kind === 'text' && b.text.includes(incoming)))) {
      return
    }

    turn.blocks.push({ endedAt: at, id: this.id('k'), kind: 'thinking', startedAt: at, text })
    this.#touch(turn)
  }

  text(text: string, at = Date.now()) {
    if (!text) {
      return
    }

    const turn = this.start(at)
    this.#endThinking(turn, at)
    const last = turn.blocks.at(-1)

    if (last?.kind === 'text') {
      last.text += text
    } else {
      turn.blocks.push({ id: this.id('x'), kind: 'text', text })
    }

    this.#touch(turn)
  }

  /** Interim commentary: seals the streamed text so the next delta starts a new block. */
  interim(text: string, { alreadyStreamed }: { alreadyStreamed: boolean }, at = Date.now()) {
    const turn = this.start(at)
    this.#endThinking(turn, at)

    if (!alreadyStreamed && text.trim()) {
      turn.blocks.push({ id: this.id('x'), kind: 'text', text })
    }

    // An empty text block marks the seal; `text()` appends to a new one after it.
    turn.blocks.push({ id: this.id('x'), kind: 'text', text: '' })
    this.#touch(turn)
  }

  toolStart(p: ToolStartPayload, at = Date.now()) {
    const turn = this.start(at)
    this.#endThinking(turn, at)

    if (this.#tool(p.tool_id)) {
      return
    }

    const call: ToolCall = {
      args: p.args ?? {},
      argsText: p.args_text ?? '',
      context: p.context ?? '',
      id: p.tool_id,
      name: p.name,
      startedAt: at,
      status: 'running'
    }

    // The call's own list shows while it runs; tool.complete's snapshot replaces it.
    if (Array.isArray(call.args.todos)) {
      call.todos = toTodos(call.args.todos)
    }

    turn.blocks.push({ call, id: p.tool_id, kind: 'tool' })
    this.#touch(turn)
  }

  toolComplete(p: ToolCompletePayload, at = Date.now()) {
    let found = this.#tool(p.tool_id)

    if (!found) {
      this.toolStart({ args: p.args ?? {}, name: p.name, tool_id: p.tool_id }, at)
      found = this.#tool(p.tool_id)
    }

    if (!found) {
      return
    }

    const { call, turn } = found

    const output = record(p.result)?.output

    // An interrupted command still completes: hermes marks its output instead of failing it.
    const interrupted =
      p.name === 'terminal' && typeof output === 'string' && /\[Command interrupted\]\s*$/.test(output)

    call.status = interrupted ? 'cancelled' : isToolError(p) ? 'error' : 'done'
    call.duration = typeof p.duration_s === 'number' ? Math.round(p.duration_s * 1000) : at - call.startedAt
    call.summary = p.summary ?? undefined
    call.resultText = p.result_text ?? undefined
    call.result = p.result
    call.diff = p.inline_diff ?? undefined

    if (p.args) {
      call.args = p.args
    }

    if (Array.isArray(p.todos)) {
      call.todos = toTodos(p.todos)
    }

    this.#touch(turn)
  }

  /** The newest todo snapshot lands on the newest todo tool call. */
  todos(todos: unknown[]) {
    const found = this.#lastTool(c => c.name === 'todo_list')

    if (found) {
      found.call.todos = toTodos(todos)
      this.#touch(found.turn)
    }
  }

  subagent(type: string, p: SubagentEventPayload, at = Date.now()) {
    // Background delegations report after their turn ended (and maybe after newer turns
    // started): find the call that dispatched them by its delegation id first.
    const found =
      (p.delegation_id
        ? this.#findTool(c => c.name === 'delegate_task' && record(c.result)?.delegation_id === p.delegation_id)
        : undefined) ?? this.#lastTool(c => c.name === 'delegate_task')

    if (!found) {
      return
    }

    const list = (found.call.subagents ??= [])
    const key = p.subagent_id ?? `task-${p.task_index}`
    let agent = list.find(a => a.id === key)

    if (!agent) {
      agent = {
        calls: 0,
        goal: p.goal,
        id: key,
        index: p.task_index,
        startedAt: at,
        status: 'queued',
        tokens: 0,
        toolCount: 0
      }
      list.push(agent)
      list.sort((a, b) => a.index - b.index)
    }

    agent.last = p
    agent.goal = p.goal || agent.goal
    agent.model = p.model ?? agent.model
    agent.toolCount = p.tool_count ?? agent.toolCount
    agent.calls = p.api_calls ?? agent.calls
    agent.tokens = (p.input_tokens ?? 0) + (p.output_tokens ?? 0) || agent.tokens

    if (type === 'subagent.start') {
      agent.status = 'running'
      agent.startedAt = at
    } else if (type === 'subagent.tool') {
      agent.status = 'running'
      agent.tool = p.tool_name ?? agent.tool
      agent.toolPreview = p.tool_preview ?? p.text ?? undefined
      agent.toolSince = { at }
    } else if (type === 'subagent.complete') {
      agent.status = p.status === 'completed' ? 'done' : p.status === 'interrupted' ? 'cancelled' : 'failed'
      agent.summary = p.summary ?? undefined
      agent.duration =
        typeof p.duration_seconds === 'number' ? Math.round(p.duration_seconds * 1000) : at - agent.startedAt
      agent.tool = undefined
    } else if (p.status === 'running') {
      agent.status = 'running'
    }

    this.#touch(found.turn)
  }

  complete(p: MessageCompletePayload, at = Date.now()) {
    const turn = this.live ?? this.start(at)
    this.#endThinking(turn, at)
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
      if (b.kind === 'tool' && b.call.status === 'running') {
        b.call.status = p.status === 'error' ? 'error' : p.status === 'interrupted' ? 'cancelled' : 'done'
        b.call.duration ??= at - b.call.startedAt
      }
    }

    turn.endedAt = at
    this.#live = undefined

    if (p.usage) {
      turn.usage = usageSince(p.usage, this.#sessionUsage)
      this.#sessionUsage = p.usage
    }

    turn.warning = p.warning ?? undefined
    turn.status = p.status === 'error' ? 'error' : p.status === 'interrupted' ? 'interrupted' : 'done'

    if (turn.status === 'error') {
      const surfaced = p.error_surface?.message
      const error = (typeof surfaced === 'string' && surfaced) || p.error || final || 'The request failed'
      const http = /^HTTP (\d{3}):\s*/.exec(error)
      const code = p.error_surface?.code
      turn.error = http ? error.slice(http[0].length) : error
      turn.errorCode = http?.[1] ?? (typeof code === 'string' && code ? code : undefined)
      // The gateway's final text is advice ("wait and /retry, or /model …") followed by the raw error.
      turn.errorHint = final.split(/\n\s*\n/)[0]?.trim() || undefined
    }

    this.#touch(turn)
  }

  /** Seals a live turn the user interrupted before the agent confirmed it. */
  interrupt(at = Date.now()) {
    const turn = this.live

    if (turn) {
      this.complete({ status: 'interrupted' }, at)
    }
  }

  /** Rebuilds the entries of a resumed session from its stored messages. */
  load(messages: TranscriptMessage[]) {
    this.entries = this.entries.filter(e => e.kind === 'welcome')
    this.#live = undefined
    let turn: TurnEntry | undefined
    const calls = new Map<string, ToolCall>()

    for (const m of messages) {
      const at = typeof m.timestamp === 'number' ? m.timestamp * 1000 : 0
      const text = typeof m.text === 'string' ? m.text : typeof m.content === 'string' ? m.content : ''

      if (m.role === 'user') {
        turn = undefined
        this.entries.push({ at, id: this.id('u'), kind: 'user', text })

        continue
      }

      if (m.role === 'system') {
        turn = undefined

        if (text.trim()) {
          this.entries.push({ id: this.id('n'), kind: 'notice', text, tone: 'info' })
        }

        continue
      }

      if (!turn) {
        turn = { blocks: [], id: this.id('t'), kind: 'turn', rev: 0, startedAt: at, status: 'done' }
        this.entries.push(turn)
      }

      if (m.role === 'assistant') {
        if (m.reasoning?.trim()) {
          turn.blocks.push({ endedAt: at, id: this.id('k'), kind: 'thinking', startedAt: at, text: m.reasoning })
        }

        if (text.trim()) {
          turn.blocks.push({ id: this.id('x'), kind: 'text', text })
        }
      } else if (m.role === 'tool') {
        const id = m.tool_call_id ?? this.id('c')
        // History keeps the result only for edit tools (`content`, JSON); the rest come back bare.
        const result = typeof m.content === 'string' && m.content ? m.content : undefined
        const existing = calls.get(id)

        if (existing) {
          existing.result = result ?? existing.result

          continue
        }

        // Deferred tools (todo_list, …) are stored as the `tool_call` bridge that ran them.
        const bridged = m.name === 'tool_call' ? bridgedCall(m.args ?? {}) : undefined
        const args = bridged?.args ?? m.args ?? {}

        const call: ToolCall = {
          args,
          argsText: '',
          context: m.context ?? '',
          duration: 0,
          id,
          name: bridged?.name ?? m.name ?? 'tool',
          result,
          startedAt: at,
          status: record(result)?.error ? 'error' : 'done'
        }

        if (Array.isArray(args.todos)) {
          call.todos = toTodos(args.todos)
        }

        calls.set(id, call)
        turn.blocks.push({ call, id: this.id('c'), kind: 'tool' })
      }
    }

    this.#touch()
  }

  /** A resumed session's unfinished turn: its prompt, then a live turn holding what streamed so far. */
  inflight(turn: InflightTurn, at = Date.now()) {
    const user = turn.user?.trim()

    if (user) {
      this.user(user, at)
    }

    if (turn.assistant || turn.streaming) {
      this.start(at)
      this.text(turn.assistant ?? '', at)
    }
  }

  #endThinking(turn: TurnEntry, at: number) {
    for (const b of turn.blocks) {
      if (b.kind === 'thinking' && b.endedAt === undefined) {
        b.endedAt = at
      }
    }
  }

  #tool(id: string): Located | undefined {
    return this.#findTool(call => call.id === id)
  }

  /** The newest call matching `match` in any turn, newest turn first. */
  #findTool(match: (call: ToolCall) => boolean): Located | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const turn = this.entries[i]

      if (turn?.kind !== 'turn') {
        continue
      }

      const hit = turn.blocks.findLast((b): b is ToolBlock => b.kind === 'tool' && match(b.call))

      if (hit) {
        return { call: hit.call, turn }
      }
    }

    return undefined
  }

  /** The newest call matching `match` in the live (else the last) turn only. */
  #lastTool(match: (call: ToolCall) => boolean): Located | undefined {
    const turn = this.live ?? this.entries.findLast(e => e.kind === 'turn')

    if (turn?.kind !== 'turn') {
      return undefined
    }

    const hit = turn.blocks.findLast((b): b is ToolBlock => b.kind === 'tool' && match(b.call))

    return hit && { call: hit.call, turn }
  }

  /** Marks a change: the transcript's, and the turn's when one changed. */
  #touch(turn?: TurnEntry) {
    this.rev++

    if (turn) {
      turn.rev++
    }
  }
}

/** The text after the last tool call: what message.complete's `text` repeats. */
function trailingText(turn: TurnEntry): string {
  let out = ''

  for (const b of turn.blocks) {
    // A tool call or an interim seal (an empty text block) starts a new response.
    if (b.kind === 'tool' || (b.kind === 'text' && !b.text)) {
      out = ''
    } else if (b.kind === 'text') {
      out += b.text
    }
  }

  return out
}

function isToolError(p: ToolCompletePayload): boolean {
  const r = record(p.result)

  if (r?.error) {
    return true
  }

  if (p.name === 'terminal' && typeof r?.exit_code === 'number' && r.exit_code !== 0) {
    return true
  }

  return typeof p.summary === 'string' && /^(error|failed)\b/i.test(p.summary)
}

/** One turn's share of the session totals: `now` minus `before`, field by field. */
function usageSince(now: Usage, before: Usage | undefined): Usage {
  const less = (key: 'cost_usd' | 'input' | 'output' | 'total') => {
    const a = now[key]
    const b = before?.[key]

    return typeof a === 'number' ? Math.max(0, a - (typeof b === 'number' ? b : 0)) : undefined
  }

  return { ...now, cost_usd: less('cost_usd'), input: less('input'), output: less('output'), total: less('total') }
}

/** A JSON object, parsing JSON text (stored tool results are strings). */
export function record(v: unknown): Record<string, unknown> | undefined {
  if (typeof v === 'string') {
    try {
      return record(JSON.parse(v))
    } catch {
      return undefined
    }
  }

  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/** The one call a stored `tool_call` bridge ran (`{name, arguments}` or `{calls: [one]}`). */
function bridgedCall(args: Record<string, unknown>): { name: string; args: Record<string, unknown> } | undefined {
  const calls = args.calls
  const entry = record(Array.isArray(calls) && calls.length === 1 ? calls[0] : args)
  const name = entry?.name

  return typeof name === 'string' && name ? { args: record(entry?.arguments) ?? {}, name } : undefined
}

function toTodos(raw: unknown[]): Todo[] {
  const out: Todo[] = []

  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue
    }

    const id = 'id' in item ? String(item.id) : String(out.length)
    const content = 'content' in item ? String(item.content) : ''
    const status = 'status' in item ? String(item.status) : 'pending'
    const parent = 'parent' in item && item.parent ? String(item.parent) : undefined

    out.push({
      content,
      id,
      ...(parent && { parent }),
      status: status === 'completed' || status === 'in_progress' || status === 'cancelled' ? status : 'pending'
    })
  }

  return out
}
