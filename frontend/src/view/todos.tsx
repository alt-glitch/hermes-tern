// The todo list as a Tern `checklist`, as the Todo card and the dock show it.

import type { JSX } from '@stencil-hq/tern'

import type { Todo } from '../model.js'
import { TODO_LOOK } from '../transcript/todos.js'

/** The todos as omp's checklist: subtasks under their parent's titled phase, else one flat phase. */
export function checklistNode(todos: Todo[]): JSX.Element {
  const item = (t: Todo) => ({ id: t.id, status: TODO_LOOK[t.status].item, text: t.content })
  const roots = todos.filter(t => !t.parent)
  const nested = todos.some(t => t.parent)

  // Subtasks group under their parent as omp's titled phases; a flat list is one untitled phase.
  const phases = nested
    ? roots.map(r => {
        const kids = todos.filter(t => t.parent === r.id)

        return {
          collapsed: kids.length > 0 && kids.every(k => k.status === 'completed'),
          id: r.id,
          items: kids.length ? kids.map(item) : [item(r)],
          title: r.content
        }
      })
    : [{ id: 'all', items: roots.map(item) }]

  return <checklist key="list" mode="full" phases={phases} />
}
