// One subagent as a Tern `agent` row: the Task card, the agents hub and the watch pane share it.

import type { JSX } from '@stencil-hq/tern'

import { optional } from '../core/assert.js'
import type { Subagent } from '../model.js'
import { age } from '../view/time.js'

import { SUBAGENT_LOOK } from './look.js'
import { agentName, OUTCOME_UNKNOWN } from './rows.js'

/** A one-agent delegation's row in place of its Task card: its own key and name. */
export interface Solo {
  key: string
  name: string
}

/**
 * One subagent as a Tern `agent` row, as the Task card and the agents hub show it. Its timer
 * gets the true age each time: Tern starts an agent's timer over whenever `stats` changes (a new
 * tool count, a status), so an age fixed at the first send would run late. The row is only
 * rebuilt when something about the agent changed, so this sends no extra frames.
 */
export function agentNode(a: Subagent, now: number, solo?: Solo): JSX.Element {
  const status = SUBAGENT_LOOK[a.status].row
  const running = a.status === 'running'

  return (
    <agent
      // A click (or the context menu) opens the agent beside the chat; App handles the action.
      actions={{ click: `open-agent=${a.id}`, menu: [`open-agent=${a.id}`] }}
      key={solo?.key ?? a.key}
      // A done row whose outcome nothing reported says so, rather than reading as a success.
      {...(a.exitReason && (a.status !== 'done' || a.exitReason === OUTCOME_UNKNOWN)
        ? { badges: [{ text: a.exitReason.replace(/_/g, ' '), tone: 'warning' }] }
        : {})}
      {...optional('collapsed', a.summary ? true : undefined)}
      {...optional('collapsible', a.summary ? true : undefined)}
      {...optional('depth', a.depth || undefined)}
      {...optional('model', a.model)}
      name={solo?.name ?? agentName(a)}
      {...optional('role', solo ? 'hermes.task.solo' : undefined)}
      stats={{
        ...optional('requests', a.calls || undefined),
        ...optional('tokens', a.tokens || undefined),
        ...optional('tools', a.toolCount || undefined),
        ...(running ? { age: Math.max(0, now - a.startedAt) } : optional('took', a.duration))
      }}
      status={status}
      task={a.goal}
      title={`Open ${solo ? 'the agent' : agentName(a)} beside the chat`}
      {...(running && a.tool
        ? {
            tool: {
              ...optional('age', a.toolSince ? age(a.toolSince, a.toolSince.at, now) : undefined),
              ...optional('intent', a.toolPreview),
              name: a.tool
            }
          }
        : {})}
    >
      {a.summary ? <md key="o">{a.summary}</md> : null}
    </agent>
  )
}
