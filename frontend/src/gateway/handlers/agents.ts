// The session's subagents as the owner streams them: a spawn, its start, thoughts, tool calls and
// progress, and its end, each folded by the agents store into the delegation's Task card.

import type { SubagentEventType } from '../../agents/rows.js'
import type { Agents } from '../../agents/store.js'
import type { PullRequests } from '../../github/store.js'
import type { EventOf, Handlers, Outcome } from '../dispatch.js'

/** What the subagents' events reach of the app. */
export interface AgentsCx {
  readonly agents: Pick<Agents, 'apply'>
  readonly prs: Pick<PullRequests, 'relink'>
}

/** The subagent events, one body for all six. */
type SubagentEvent = EventOf<SubagentEventType>

/** A subagent's step, folded into its row; at its end, the PRs it linked are filed under this conversation. */
function subagent(ev: SubagentEvent, cx: AgentsCx): Outcome {
  if (ev.payload) {
    cx.agents.apply(ev.type, ev.payload)
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
