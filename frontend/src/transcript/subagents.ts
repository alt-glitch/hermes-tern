// A `subagent.*` event folded into the rows of the delegate_task call that dispatched it: the
// row for its subagent (a new one in task order), its counts, its status and its current tool.

import type { SubagentEventPayload } from '@hermes/shared/gateway-events'

import type { ToolCall } from '../model.js'

/** One `subagent.*` event: its type, its payload, and when it arrived. */
export interface SubagentEvent {
  type: string
  event: SubagentEventPayload
  at: number
}

/** Folds `event` into `call`'s subagent rows. */
export function foldSubagent(call: ToolCall, { type, event, at }: SubagentEvent) {
  const list = (call.subagents ??= [])
  const key = event.subagent_id ?? `task-${event.task_index}`
  let agent = list.find(a => a.id === key)

  if (!agent) {
    agent = {
      calls: 0,
      goal: event.goal,
      id: key,
      index: event.task_index,
      startedAt: at,
      status: 'queued',
      tokens: 0,
      toolCount: 0
    }
    list.push(agent)
    list.sort((a, b) => a.index - b.index)
  }

  agent.last = event
  agent.goal = event.goal || agent.goal
  agent.model = event.model ?? agent.model
  agent.toolCount = event.tool_count ?? agent.toolCount
  agent.calls = event.api_calls ?? agent.calls
  agent.tokens = (event.input_tokens ?? 0) + (event.output_tokens ?? 0) || agent.tokens

  if (type === 'subagent.start') {
    agent.status = 'running'
    agent.startedAt = at
  } else if (type === 'subagent.tool') {
    agent.status = 'running'
    agent.tool = event.tool_name ?? agent.tool
    agent.toolPreview = event.tool_preview ?? event.text ?? undefined
    agent.toolSince = { at }
  } else if (type === 'subagent.complete') {
    agent.status = event.status === 'completed' ? 'done' : event.status === 'interrupted' ? 'cancelled' : 'failed'
    agent.summary = event.summary ?? undefined
    agent.duration =
      typeof event.duration_seconds === 'number' ? Math.round(event.duration_seconds * 1000) : at - agent.startedAt
    agent.tool = undefined
  } else if (event.status === 'running') {
    agent.status = 'running'
  }
}
