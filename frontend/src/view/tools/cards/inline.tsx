// The small cards with no family of their own: the todo list, memory, and the skill tools.

import type { Todo, ToolCall } from '../../../model.js'
import type { MemoryDetail, SkillDetail, SkillsDetail } from '../../../tools/misc.js'
import { clip, plural } from '../../format.js'
import { checklistNode } from '../../todos.js'
import { namedStep } from '../steps.js'
import type { Card, ToolView } from '../types.js'

/** The todo tool's view (`todo_list`, and `todo`, the legacy name stored transcripts and older backends keep). */
export const todoView: ToolView<'todo_list'> = {
  action: 'plan',
  card: todoCard,
  step: call => planStep(call.todosBefore, call.todos)
}

/** The memory tool's view. */
export const memoryView: ToolView<'memory'> = { action: 'other', card: memoryCard, step: namedStep }

/** The skills_list tool's view. */
export const skillsView: ToolView<'skills_list'> = { action: 'other', card: skillsCard, step: () => 'Listed skills' }

/** The skill_view tool's view. */
export const skillView: ToolView<'skill_view'> = {
  action: 'other',
  card: skillCard,
  step: (_call, d) => (d.name ? `Read skill ${d.name}` : 'Read a skill')
}

/** The todo tool: the list as a checklist, its done count in the head. */
function todoCard(call: ToolCall): Card {
  return {
    body: call.todos?.length ? [checklistNode(call.todos)] : [],
    name: 'todo',
    target: todoCount(call.todos),
    targetKind: 'text',
    title: 'Todo'
  }
}

/** The memory tool: one line, its action and how full memory is. */
function memoryCard(call: ToolCall, d: MemoryDetail): Card {
  return {
    body: [],
    frame: 'inline',
    meta: d.usage ? [d.usage] : undefined,
    name: 'memory',
    target: call.context || d.action,
    targetKind: 'text',
    title: 'Memory'
  }
}

/** skills_list: the skill names, folded under their count. */
function skillsCard(_call: ToolCall, d: SkillsDetail): Card {
  const names = d.names

  return {
    body: names.length ? [<text key="names" spans={[{ s: 'muted', t: names.join(' · ') }]} wrap="word" />] : [],
    folded: true,
    frame: 'inline',
    meta: [
      names.length ? plural(names.length, 'skill') : (d.message ?? 'no skills')
    ],
    name: 'skill',
    title: 'Skills'
  }
}

/** skill_view: the skill's text, folded. */
function skillCard(call: ToolCall, d: SkillDetail): Card {
  return {
    body: d.content ? [<md key="body">{clip(d.content, { mark: 'line', max: 6000 })}</md>] : [],
    folded: true,
    frame: 'inline',
    name: 'skill',
    target: d.name ?? call.context,
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

const MARK: Record<Todo['status'], string> = { cancelled: '✗', completed: '✓', in_progress: '→', pending: '○' }

/**
 * A todo call as one step, in t3code's words for a plan change ("Plan updated"): what it changed
 * in the list before it, each item marked with its new state ("✓ Write tests, → Run the suite");
 * an item it added reads "+ …". The first list reads "Planned 4 steps".
 */
export function planStep(before: readonly Todo[] | undefined, after: readonly Todo[] | undefined): string {
  if (!after?.length) {
    return 'Plan updated'
  }

  if (!before?.length) {
    return `Planned ${plural(after.length, 'step')}`
  }

  const changes = after.flatMap(t => {
    const was = before.find(b => b.id === t.id)

    return !was ? [`+ ${t.content}`] : was.status !== t.status ? [`${MARK[t.status]} ${t.content}`] : []
  })

  return changes.length ? `Plan updated: ${changes.join(', ')}` : 'Plan updated'
}
