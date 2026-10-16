// The transcript as ui-tsp keeps it: structured entries built from gateway
// events (see transcript.ts), never pre-rendered text. Views (view/*.tsx)
// derive TSP nodes from these.

import type { SubagentEventPayload, Usage } from '@hermes/shared/gateway-events'

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

/** A user prompt. */
export interface UserEntry {
  kind: 'user'
  id: string
  text: string
  at: number
}

/** One assistant turn: thinking, text and tool calls as they arrived. */
export interface TurnEntry {
  kind: 'turn'
  id: string
  /** Bumped on every change to the turn, so views rebuild only the turns that changed. */
  rev: number
  blocks: Block[]
  startedAt: number
  endedAt?: number
  status: 'done' | 'error' | 'interrupted' | 'live'
  usage?: Usage
  error?: string
  /** The HTTP status or error code of a failed request, for the error card's badge. */
  errorCode?: string
  /** The gateway's advice on a failed request (what to try next). */
  errorHint?: string
  warning?: string
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
