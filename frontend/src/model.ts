// The transcript as ui-tsp keeps it: structured entries built from gateway
// events (see transcript.ts), never pre-rendered text. Views (view/*.tsx)
// derive TSP nodes from these.

import type { SubagentEventPayload, Usage } from '@hermes/shared/gateway-events'

import type { LiveLog } from './agents/liveLog.js'

/** One todo item as the `todo_list` tool reports it. */
export interface Todo {
  id: string
  content: string
  status: 'cancelled' | 'completed' | 'in_progress' | 'pending'
  parent?: string
}

/** One delegated child agent, folded from `subagent.*` events. */
export interface Subagent {
  id: string
  goal: string
  index: number
  /** The row's node key when it differs from `id`: a dispatch placeholder keeps it after the owner names the child. */
  key?: string
  /** Display name, for nested children (`Agent 2.1`); else `Agent <index + 1>`. */
  name?: string
  status: 'cancelled' | 'done' | 'failed' | 'queued' | 'running'
  model?: string
  tool?: string
  toolPreview?: string
  /** When the current tool started; a fresh object per tool so its Tern timer is sent once. */
  toolSince?: { at: number }
  toolCount: number
  tokens: number
  calls: number
  summary?: string
  startedAt: number
  duration?: number
  last?: SubagentEventPayload
  /** The dispatching delegation's id. */
  delegationId?: string
  /** Nesting below the delegating session: 0 for a child the session spawned. */
  depth?: number
  /** The subagent that spawned this one (nested delegation). */
  parentId?: string
  /** The live transcript log on this machine (`live_transcripts` of the dispatch result). */
  logPath?: string
  /** That log, parsed: the agent's timeline. */
  log?: LiveLog
  /** The owner takes steering text for it now (`accepting_steer`). */
  steerable?: boolean
  /** Why it ended, when the log says (max_iterations, …) or its error. */
  exitReason?: string
}

/** One tool call, from `tool.start` to `tool.complete`. */
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  argsText: string
  /** The gateway's one-line description of the call (`context`). */
  context: string
  status: 'cancelled' | 'done' | 'error' | 'running'
  startedAt: number
  /** Milliseconds, once done. */
  duration?: number
  summary?: string
  resultText?: string
  result?: unknown
  /** A unified diff of the files the call changed. */
  diff?: string
  todos?: Todo[]
  subagents?: Subagent[]
}

/** A part of an assistant turn, in the order it streamed. */
export type Block =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string; startedAt: number; endedAt?: number }
  | { kind: 'tool'; id: string; call: ToolCall }
  /** Guidance the user sent into this turn while it ran; it lands before the agent's next step. */
  | { kind: 'steer'; id: string; text: string; at: number }

/** A user prompt. */
export interface UserEntry {
  kind: 'user'
  id: string
  text: string
  at: number
  /** Injected into a running turn rather than starting one. */
  steered?: boolean
}

/** One assistant turn: thinking, text and tool calls as they arrived. */
export interface TurnEntry {
  kind: 'turn'
  id: string
  /** Why a turn with no prompt of its own started ("Subagents finished"): Hermes went on by itself. */
  continued?: string
  /** Bumped on every change to the turn, so views rebuild only the turns that changed. */
  rev: number
  blocks: Block[]
  startedAt: number
  endedAt?: number
  status: 'done' | 'error' | 'interrupted' | 'live'
  usage?: Usage
  /** The session's cumulative counters when the turn began (from `session.usage` ticks). */
  countersAtStart?: Counters
  /** This turn's share of prompt tokens read from the provider's cache, in percent. */
  cacheHit?: number
  /** Tokens this turn used, from the ticks (message.complete does not always carry usage). */
  tickTokens?: number
  /** Output tokens per second over the recent model calls, at the turn's last tick. */
  tps?: number
  error?: string
  /** The HTTP status or error code of a failed request, for the error card's badge. */
  errorCode?: string
  /** The gateway's advice on a failed request (what to try next). */
  errorHint?: string
  warning?: string
}

/** A session's cumulative token counters, as `session.usage` ticks report them. */
export interface Counters {
  prompt: number
  read: number
  total: number
}

/** A line from the app or the gateway: a notice, a warning, an error. */
export interface NoticeEntry {
  kind: 'notice'
  id: string
  text: string
  tone: 'error' | 'info' | 'success' | 'warning'
}

/** Output of a slash command, shown as Markdown. */
export interface PanelEntry {
  kind: 'panel'
  id: string
  title: string
  text: string
}

/** The session's opening card. */
export interface WelcomeEntry {
  kind: 'welcome'
  id: string
}

export type Entry = NoticeEntry | PanelEntry | TurnEntry | UserEntry | WelcomeEntry
