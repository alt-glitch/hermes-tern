// The small cards with no family of their own: the todo list, memory, and the skill tools.

import type { Todo, ToolCall } from '../../../model.js'
import { record } from '../../../wire/json.js'
import { clip, nonEmpty, plural } from '../../format.js'
import { checklistNode } from '../../todos.js'
import type { Card } from '../types.js'

/** The todo tool: the list as a checklist, its done count in the head. */
export function todoCard(call: ToolCall): Card {
  return {
    body: call.todos?.length ? [checklistNode(call.todos)] : [],
    name: 'todo',
    target: todoCount(call.todos),
    targetKind: 'text',
    title: 'Todo'
  }
}

/** The memory tool: one line, its action and how full memory is. */
export function memoryCard(call: ToolCall, result: Record<string, unknown> | undefined): Card {
  return {
    body: [],
    frame: 'inline',
    meta: nonEmpty(result?.usage) ? [`${result?.usage}`] : undefined,
    name: 'memory',
    target: call.context || nonEmpty(call.args.action),
    targetKind: 'text',
    title: 'Memory'
  }
}

/** skills_list: the skill names, folded under their count. */
export function skillsCard(result: Record<string, unknown> | undefined): Card {
  const skills = Array.isArray(result?.skills) ? result.skills : []
  const names = skills.map(s => nonEmpty(record(s)?.name) ?? nonEmpty(s)).filter(n => n !== undefined)

  return {
    body: names.length ? [<text key="names" spans={[{ s: 'muted', t: names.join(' · ') }]} wrap="word" />] : [],
    folded: true,
    frame: 'inline',
    meta: [
      names.length ? plural(names.length, 'skill') : (nonEmpty(result?.message) ?? 'no skills')
    ],
    name: 'skill',
    title: 'Skills'
  }
}

/** skill_view: the skill's text, folded. */
export function skillCard(call: ToolCall, result: Record<string, unknown> | undefined): Card {
  return {
    body: nonEmpty(result?.content) ? [<md key="body">{clip(nonEmpty(result?.content) ?? '', { mark: 'line', max: 6000 })}</md>] : [],
    folded: true,
    frame: 'inline',
    name: 'skill',
    target: nonEmpty(call.args.name) ?? call.context,
    targetKind: 'text',
    title: 'Skill'
  }
}

function todoCount(todos: Todo[] | undefined): string | undefined {
  if (!todos?.length) {
    return undefined
  }

  return `${todos.filter(t => t.status === 'completed').length}/${todos.length}`
}
