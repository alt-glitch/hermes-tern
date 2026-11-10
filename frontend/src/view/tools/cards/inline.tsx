// The small cards with no family of their own: the todo list, memory, and the skill tools.

import { clip, plural } from '../../../core/text.js'
import type { Todo, ToolCall } from '../../../model.js'
import { memoryStagingReported } from '../../../tools/memory-staged.js'
import type { MemoryDetail, SkillDetail, SkillsDetail } from '../../../tools/misc.js'
import { unchangedSkillFile } from '../../../tools/skill-stub.js'
import { todoProgress } from '../../../transcript/todos.js'
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
  step: (call, d) => unchangedSkillFile(call)
    ? (d.name ? `Skill view unchanged: ${d.name}` : 'Skill view unchanged')
    : (d.name ? `Read skill ${d.name}` : 'Read a skill')
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
  const staged = memoryStagingReported(call)
  return {
    body: staged ? [<text key="staged" role="omp.tool.notice" text="Hermes reported this memory change was staged for approval; application was not confirmed." wrap="word" />] : [],
    ...(staged ? { folded: false } : { frame: 'inline' as const }),
    meta: staged ? [...(d.usage ? [d.usage] : []), 'Staging reported'] : d.usage ? [d.usage] : undefined,
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
  const file = unchangedSkillFile(call)
  if (file) {
    let end = Math.min(file.length, 256)
    if (end < file.length && end > 0 && /[\uD800-\uDBFF]/.test(file[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(file[end] ?? '')) end--
    const prefix = file.slice(0, end)
    const safe = Array.from(prefix, c => {
      const n = c.codePointAt(0) ?? 0
      return (n < 32 || (n >= 0x7f && n <= 0x9f) || n === 0x061c || n === 0x200e || n === 0x200f ||
        (n >= 0x2028 && n <= 0x202e) || (n >= 0x2066 && n <= 0x206f) || (n >= 0xd800 && n <= 0xdfff))
        ? `\\u${n.toString(16).padStart(4, '0')}` : c
    }).join('')
    const notice = 'Hermes reports this skill view is unchanged; content was not returned.'
    return {
      body: [
        <text key="unchanged" role="omp.tool.notice" text={notice} wrap="word" />,
        <text key="file" role="omp.tool.notice" text={`File: ${safe}`} wrap="word" />,
        ...(end < file.length ? [<text key="file-clipped" role="omp.tool.notice" text="File name clipped in view" />] : []),
        ...(safe !== prefix ? [<text key="file-escaped" role="omp.tool.notice" text="File name control characters escaped in view" />] : [])
      ],
      folded: false,
      frame: 'inline',
      meta: [notice],
      name: 'skill',
      target: d.name ?? call.context,
      targetKind: 'text',
      title: 'Skill'
    }
  }
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

  // As the pill and the panel count: a cancelled item drops out.
  const { done, total } = todoProgress(todos)

  return `${done}/${total}`
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
