// The session's subagents as the owner streams them: a spawn, its start, thoughts, tool calls and
// progress, and its end, each folded into the delegation's Task card.

import type { PullRequests } from '../../github/store.js'
import type { Transcript } from '../../transcript.js'
import type { EventOf, Handlers, Outcome } from '../dispatch.js'

/** What the subagents' events reach of the app. */
export interface AgentsCx {
  readonly transcript: Pick<Transcript, 'subagent'>
  readonly prs: Pick<PullRequests, 'relink'>
}

/** The subagent events, one body for all six. */
type SubagentEvent = EventOf<
  'subagent.complete' | 'subagent.progress' | 'subagent.spawn_requested' | 'subagent.start' | 'subagent.thinking' | 'subagent.tool'
>

/** A subagent's step, folded into its row; at its end, the PRs it linked are filed under this conversation. */
function subagent(ev: SubagentEvent, cx: AgentsCx): Outcome {
  if (ev.payload) {
    cx.transcript.subagent(ev.type, ev.payload)
  }

  if (ev.type === 'subagent.complete') {
    // A subagent ended: the PRs it linked are filed under this conversation (pull_requests.py).
    cx.prs.relink()
  }

  return 'render'
}

/** The subagents' events. */
export const agentHandlers = {
  'subagent.spawn_requested': subagent,
  'subagent.start': subagent,
  'subagent.thinking': subagent,
  'subagent.tool': subagent,
  'subagent.progress': subagent,
  'subagent.complete': subagent
} satisfies Handlers<AgentsCx>
