// The transcript as ui-tsp keeps it: structured entries built from gateway
// events (see transcript.ts), never pre-rendered text. Views (view/*.tsx)
// derive TSP nodes from these.

import type { SubagentEventPayload, Usage } from '@hermes/shared/gateway-events'

import type { LiveLog } from './agents/liveLog.js'
import type { BatchEntry } from './bridge.js'
import type { ConnectCard } from './connections.js'
import type { BlockKey, EntryId, ToolCallId } from './core/ids.js'
import type { ChartView } from './processes/widgets/types.js'

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

/** A tracked background process (`terminal(background=true)`), as `process.list` last reported it. */
export interface BackgroundProcess {
  /** The registry's process id (`proc_…`): `process.list`'s `session_id`, the terminal result's `session_id`. */
  id: string
  command: string
  /** `unknown`: it ran, and `process.list` has failed since (see Processes), so nothing says whether it still does. */
  status: 'done' | 'failed' | 'killed' | 'lost' | 'running' | 'unknown'
  /** Epoch milliseconds. */
  startedAt: number
  /** Epoch milliseconds, once it exited and the gateway says when. */
  exitedAt?: number
  exitCode?: number
  /** The registry's `completion_reason` (killed, lost, failed_start, …). */
  reason?: string
  /** The newest output the gateway sends (its tail). */
  output: string
  /** The last non-empty output line, plain text. */
  lastLine: string
  /** Its live chart (processes/widgets): kept by the store, the same object while it does not change. */
  chart?: ChartView
}

/** One tool call, from `tool.start` to `tool.complete`. */
export interface ToolCall {
  id: ToolCallId
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
  /** A todo call's list as the call found it: what its step line says it changed. */
  todosBefore?: Todo[]
  subagents?: Subagent[]
  /** The background process a `terminal(background=true)` call started (or a `process` call watches), while the store follows it. */
  process?: BackgroundProcess
  /** It ran through Tool Search's `tool_call` bridge; `name` and `args` are the tool it ran. */
  via?: 'tool_call'
  /** A bridge call of several tools (a connector batch): each with its own outcome. */
  batch?: BatchEntry[]
  /** A no-card `manage_connections` call's card: its apps, their states kept current by the app's poll. */
  connect?: ConnectCard
  /** The image it showed (media.ts), once a URL's bytes arrived; null when they could not be fetched. */
  image?: ImageSource | null
}

/** A part of an assistant turn, in the order it streamed. */
export type Block =
  | { kind: 'text'; id: EntryId; text: string }
  /** A thought; `label` names one that is not the agent's own (a Mixture-of-Agents reference answer). */
  | { kind: 'thinking'; id: EntryId; text: string; startedAt: number; endedAt?: number; label?: string }
  /** Keyed by its call's id when it streamed, by an entry id when it came from the stored history. */
  | { kind: 'tool'; id: BlockKey; call: ToolCall }
  /** Guidance the user sent into this turn while it ran; it lands before the agent's next step. */
  | { kind: 'steer'; id: EntryId; text: string; at: number }
  /** The context compacted while the turn ran. */
  | { kind: 'compaction'; id: EntryId; at: number; compaction: Compaction }

/**
 * One compaction: Hermes summarized the earlier conversation to free context. The agent reads the
 * summary from then on; the turns before it stay in the transcript for the user.
 */
export interface Compaction {
  status: 'done' | 'running'
  /** Epoch ms; a stored one knows only when its summary was written. */
  startedAt: number
  endedAt?: number
  /** Context tokens before and after, as Hermes' lines and the next context reading say. */
  before?: number
  after?: number
  /** How many messages it summarized. */
  messages?: number
  /** The summary the agent goes on from, without the handoff's instructions to the model. */
  summary?: string
  /** /compress ran it, not Hermes on its own. */
  manual?: boolean
}

/** An image an `image` node shows: a file Tern reads, or bytes sent once as a blob. */
export type ImageSource = { path: string } | { blob: string }

/** A file or image a prompt carried; `source` is unset when the image is gone (a resumed prompt's deleted file). */
export interface UserAttachment {
  kind: 'file' | 'image'
  name: string
  source?: ImageSource
}

/** A user prompt. */
export interface UserEntry {
  kind: 'user'
  id: EntryId
  text: string
  at: number
  /** Injected into a running turn rather than starting one. */
  steered?: boolean
  /** Its images (thumbnails over the words) and files. */
  attachments?: UserAttachment[]
}

/** One assistant turn: thinking, text and tool calls as they arrived. */
export interface TurnEntry {
  kind: 'turn'
  id: EntryId
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
  id: EntryId
  text: string
  tone: 'error' | 'info' | 'success' | 'warning'
}

/** Output of a slash command, shown as Markdown. */
export interface PanelEntry {
  kind: 'panel'
  id: EntryId
  title: string
  text: string
}

/** A compaction between turns (/compress, or one before the turn that needed it). */
export interface CompactionEntry {
  kind: 'compaction'
  id: EntryId
  /** Bumped when it ends or learns its numbers or summary. */
  rev: number
  compaction: Compaction
}

/** The session's opening card. */
export interface WelcomeEntry {
  kind: 'welcome'
  id: EntryId
}

export type Entry = CompactionEntry | NoticeEntry | PanelEntry | TurnEntry | UserEntry | WelcomeEntry
