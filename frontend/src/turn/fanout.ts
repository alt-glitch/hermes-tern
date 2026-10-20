// What a finished tool call and a finished message set going: the stores that follow the turn,
// each told in a fixed order. Plain functions, so the order is the one written here.

import type { MessageCompletePayload, ToolCompletePayload } from '@hermes/shared/gateway-events'

import type { Agents } from '../agents/store.js'
import { CONNECT_TOOL } from '../connections/cards.js'
import type { ConnectWatcher } from '../connections/watcher.js'
import { toolCallId } from '../core/ids.js'
import { LINK_TOOLS } from '../github/links.js'
import type { PullRequests } from '../github/store.js'
import type { ToolCall } from '../model.js'
import type { Processes } from '../processes/store.js'
import type { Sidebar } from '../sidebar.js'
import type { Transcript } from '../transcript/store.js'

import type { Activity } from './activity.js'

/** The tools that may change files: the session sidebar reads git again after each. */
const CHANGES_FILES = ['patch', 'terminal', 'write_file', 'execute_code']

/** What a finished tool call tells. */
export interface ToolFanout {
  readonly transcript: Pick<Transcript, 'call' | 'calls'>
  readonly agents: Pick<Agents, 'scan'>
  readonly prs: Pick<PullRequests, 'onCall' | 'relink'>
  readonly sidebar: Pick<Sidebar, 'poke'>
  readonly connect: Pick<ConnectWatcher, 'watch'>
  readonly processes: Pick<Processes, 'poke'>
  /** Has the call's image (a URL's) fetched; its card shows it once it lands. */
  showImage(call: ToolCall | undefined): void
}

/**
 * After the transcript folded a tool.complete: its image, the delegation's agents, the PRs it
 * linked, the sidebar, the connect cards and the background processes, in that order.
 */
export function afterToolComplete(p: Pick<ToolCompletePayload, 'name' | 'tool_id'>, cx: ToolFanout) {
  cx.showImage(cx.transcript.call(toolCallId(p.tool_id)))
  // A dispatched delegation: its agents' rows start following the owner.
  cx.agents.scan()

  if (p.name === 'delegate_task') {
    // Its subagents (a foreground call's have ended) may have linked PRs.
    cx.prs.relink()
  }

  if (LINK_TOOLS.has(p.name)) {
    const call = cx.transcript.calls(p.name).at(-1)

    if (call) {
      cx.prs.onCall(call)
    }
  }

  if (CHANGES_FILES.includes(p.name)) {
    cx.sidebar.poke()
  }

  if (p.name === CONNECT_TOOL) {
    cx.connect.watch()
  }

  if (p.name === 'terminal') {
    // Maybe a background start: its card's live line begins now, not at the next idle poll.
    cx.processes.poke()
  }
}

/** What a finished message tells. */
export interface MessageFanout {
  readonly transcript: Pick<Transcript, 'complete' | 'uncompact'>
  readonly activity: Pick<Activity, 'endBusy' | 'endCompaction'>
  readonly prs: Pick<PullRequests, 'poke'>
  readonly sidebar: Pick<Sidebar, 'poke'>
  /** Gives the compactions seen here their summaries from the store. */
  summarize(): void
  /** Sends the oldest queued prompt, if the session is idle now. */
  drain(): void
}

/**
 * A message.complete that ends the turn: the transcript folds it, the working line and any
 * compaction end, the queue drains, and the PRs and the sidebar read again, in that order.
 */
export function afterMessageComplete(p: MessageCompletePayload, cx: MessageFanout) {
  cx.transcript.complete(p)
  cx.activity.endBusy()
  cx.activity.endCompaction()
  // A compaction Hermes aborted sends no done edge; one that committed has its summary stored now.
  cx.transcript.uncompact('running')
  cx.summarize()
  cx.drain()
  // The turn may have pushed a branch, opened a PR or changed files.
  cx.prs.poke()
  cx.sidebar.poke()
}
