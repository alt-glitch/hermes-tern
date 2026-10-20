// The transcript as ui-tsp keeps it: structured entries built from gateway
// events (see transcript/store.ts), never pre-rendered text. Views (view/*.tsx)
// derive TSP nodes from these.

import type { SubagentEventPayload, Usage } from '@hermes/shared/gateway-events'

import type { LiveLog } from './agents/liveLog.js'
import type { ConnectCard } from './connections/cards.js'
import type { NonEmpty } from './core/assert.js'
import type { BlockKey, EntryId, SubagentKey, ToolCallId } from './core/ids.js'
import type { ChartView } from './processes/widgets/types.js'
import type { BatchEntry } from './tools/bridge.js'

/** One todo item as the `todo_list` tool reports it. */
export interface Todo {
  id: string
  content: string
  status: 'cancelled' | 'completed' | 'in_progress' | 'pending'
  parent?: string
}

/** One delegated child agent, folded from `subagent.*` events. */
export interface Subagent {
  /** The owner's id for it, or a dispatch placeholder's (`task-<i>`) until the owner names it. */
  id: string
  goal: string
  index: number
  /** The row's node key, set when the row is made and never changed. */
  readonly key: SubagentKey
  /** Display name, for nested children (`Agent 2.1`); else `Agent <index + 1>`. */
  name?: string | undefined
  status: 'cancelled' | 'done' | 'failed' | 'queued' | 'running'
  model?: string | undefined
  tool?: string | undefined
  toolPreview?: string | undefined
  /** When the current tool started; a fresh object per tool so its Tern timer is sent once. */
  toolSince?: { at: number }
  toolCount: number
  tokens: number
  calls: number
  summary?: string | undefined
  startedAt: number
  duration?: number | undefined
  last?: SubagentEventPayload
  /** The dispatching delegation's id. */
  delegationId?: string | undefined
  /** Nesting below the delegating session: 0 for a child the session spawned. */
  depth?: number
  /** The subagent that spawned this one (nested delegation). */
  parentId?: string
  /** The live transcript log on this machine (`live_transcripts` of the dispatch result). */
  logPath?: string | undefined
  /** That log, parsed: the agent's timeline. */
  log?: LiveLog
  /** The owner takes steering text for it now (`accepting_steer`). */
  steerable?: boolean | undefined
  /** Why it ended, when the log says (max_iterations, …) or its error. */
  exitReason?: string | undefined
}

/** A tracked background process (`terminal(background=true)`), as `process.list` last reported it. */
export interface BackgroundProcess {
  /** The registry's process id (`proc_…`): `process.list`'s `session_id`, the terminal result's `session_id`. */
  id: string
  command: string
  /** Running, else how it ended; replaced whole when it changes (the process stays the same object). */
  state: ProcessState
  /** Epoch milliseconds. */
  startedAt: number
  /** The newest output the gateway sends (its tail). */
  output: string
  /** The last non-empty output line, plain text. */
  lastLine: string
  /** Its live chart (processes/widgets): kept by the store, the same object while it does not change. */
  chart?: ChartView | undefined
}

/**
 * Where a tool call stands: running, else how it ended. An ended call knows how long it took
 * (milliseconds) and, from `tool.complete`, the gateway's one-line summary.
 */
export type ToolOutcome =
  | { kind: 'running' }
  | { kind: 'cancelled' | 'done' | 'error'; duration: number; summary?: string }

/**
 * How a call reached its tool. `bridged`: through Tool Search's `tool_call` bridge, and the call's
 * `name` and `args` are the one tool it ran. `batch`: a bridge call of several tools (a connector
 * batch), each entry with its own outcome.
 */
export type Via = { kind: 'direct' } | { kind: 'bridged' } | { kind: 'batch'; entries: NonEmpty<BatchEntry> }

/**
 * Where a background process stands, as `process.list` last said. `unknown`: it ran, and
 * `process.list` has failed since (see Processes), so nothing says whether it still does. An
 * ended one has, as far as the gateway says: when it exited (epoch milliseconds), its exit code,
 * and the registry's `completion_reason` (killed, lost, failed_start, …).
 */
export type ProcessState =
  | { status: 'running' }
  | { status: 'unknown' }
  | { status: 'done' | 'failed' | 'killed' | 'lost'; exitedAt?: number; exitCode?: number; reason?: string }

/** A background process that was seen to end: how. */
export type ProcessEnd = Exclude<ProcessState, { status: 'running' | 'unknown' }>

/** One tool call, from `tool.start` to `tool.complete`. */
export interface ToolCall {
  id: ToolCallId
  name: string
  args: Record<string, unknown>
  argsText: string
  /** The gateway's one-line description of the call (`context`). */
  context: string
  /** Running, else how it ended; replaced whole when it changes (the call stays the same object). */
  outcome: ToolOutcome
  startedAt: number
  resultText?: string | undefined
  result?: unknown
  /** A unified diff of the files the call changed. */
  diff?: string | undefined
  todos?: Todo[]
  /** A todo call's list as the call found it: what its step line says it changed. */
  todosBefore?: Todo[] | undefined
  subagents?: Subagent[]
  /** The background process a `terminal(background=true)` call started (or a `process` call watches), while the store follows it. */
  process?: BackgroundProcess
  /** How it was called: directly, or through Tool Search's `tool_call` bridge (one tool, or a batch). */
  via: Via
  /** A no-card `manage_connections` call's card: its apps, their states kept current by the app's poll. */
  connect?: ConnectCard | undefined
  /** The image it showed (media.ts), once a URL's bytes arrived; null when they could not be fetched. */
  image?: ImageSource | null | undefined
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
  /** Running, else done with what it left; replaced or filled in place (the compaction stays the same object). */
  state: CompactionState
  /** Epoch ms; a stored one knows only when its summary was written. */
  startedAt: number
  /** Context tokens before, as Hermes' lines say. */
  before?: number | undefined
  /** /compress ran it, not Hermes on its own. */
  manual?: boolean | undefined
}

/**
 * Where a compaction stands. A done one knows when it ended (a stored one does not), and later
 * what it left: the context tokens after it (the owner's count or the next context reading), and
 * from the store the messages it summarized and the summary the agent goes on from (without the
 * handoff's instructions to the model).
 */
export type CompactionState =
  | { status: 'running' }
  | { status: 'done'; endedAt?: number; after?: number; messages?: number; summary?: string }

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
  continued?: string | undefined
  /** Bumped on every change to the turn, so views rebuild only the turns that changed. */
  rev: number
  blocks: Block[]
  startedAt: number
  /** Live while it streams, else how it ended; replaced whole when it changes (the turn stays the same object). */
  end: TurnEnd
  usage?: Usage
  /** The session's cumulative counters when the turn began (from `session.usage` ticks). */
  countersAtStart?: Counters | undefined
  /** This turn's share of prompt tokens read from the provider's cache, in percent. */
  cacheHit?: number | undefined
  /** Tokens this turn used, from the ticks (message.complete does not always carry usage). */
  tickTokens?: number | undefined
  /** Output tokens per second over the recent model calls, at the turn's last tick. */
  tps?: number | undefined
  warning?: string | undefined
}

/**
 * How a turn stands: live while it streams, else how it ended and when (a stored turn whose rows
 * carry no time does not know when). A failed one carries its error card: the message (a failed
 * turn from an older store knows only the advice), the HTTP status or error code for its badge,
 * and the gateway's advice on what to try next.
 */
export type TurnEnd =
  | { status: 'live' }
  | { status: 'done' | 'interrupted'; endedAt?: number }
  | { status: 'error'; endedAt?: number; error?: string | undefined; code?: string | undefined; hint?: string | undefined }

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
