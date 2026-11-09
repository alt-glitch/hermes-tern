// The todo list as a Tern `checklist`, as the Todo card and the dock show it.

import type { ChecklistPhase, JSX } from '@stencil-hq/tern'

import type { Todo } from '../model.js'
import { TODO_LOOK, todoProgress } from '../transcript/todos.js'

/** The todos as a checklist: the full ordered list, with parent references for nested items. */
export function checklistNode(todos: Todo[]): JSX.Element {
  const item = (t: Todo) => ({ id: t.id, status: TODO_LOOK[t.status].item, text: t.content })
  const nested = todos.some(t => t.parent)
  // Tern has flat items within a phase. Preserve Hermes' priority order in one
  // phase, with each item's parent in its text: plain output omits item notes.
  const phases = nested ? nestedPhases(todos) : [{ id: 'all', items: todos.map(item) }]

  return <checklist key="list" mode="full" phases={phases} />
}

/** The dock's todo panel: a head with the done count over the list, which scrolls under it. */
export function todoPanelNode(todos: Todo[]): JSX.Element {
  const { done, total } = todoProgress(todos)

  return (
    <col key="todos" role="hermes.todos">
      <row key="head" role="hermes.todos.head">
        <text key="title" role="hermes.todos.title" spans={[{ t: 'Todos' }]} wrap="none" />
        <text key="count" role="hermes.todos.count" spans={[{ s: 'muted', t: `${done} of ${total} done` }]} wrap="none" />
      </row>
      <col key="body" role="hermes.todos.list">
        {checklistNode(todos)}
      </col>
    </col>
  )
}

/**
 * The checklist's phases: one untitled phase for a flat list, else a titled phase per parent over
 * all its descendants (the checklist nests one level), and untitled runs of the items between.
 */
export function todoPhases(todos: readonly Todo[]): ChecklistPhase[] {
  const item = (t: Todo) => ({ id: t.id, status: TODO_LOOK[t.status].item, text: t.content })

  if (!todos.some(t => t.parent)) {
    return [{ id: 'all', items: todos.map(item) }]
  }

  const byId = new Map(todos.map(t => [t.id, t]))
  // A subtask's top-level parent; a missing parent, or a cycle, leaves the item at the top.
  const rootOf = (t: Todo): Todo => {
    const seen = new Set<string>()
    let cur = t

    while (cur.parent && !seen.has(cur.id)) {
      seen.add(cur.id)
      const up = byId.get(cur.parent)

      if (!up) {
        break
      }

      cur = up
    }

    return cur
  }

  const under = new Map<string, Todo[]>()

  for (const t of todos) {
    const root = rootOf(t)

    if (root !== t) {
      under.set(root.id, [...(under.get(root.id) ?? []), t])
    }
  }

  // Phase ids key the checklists, so each kind has its own prefix: a todo id cannot collide.
  const phases: ChecklistPhase[] = []
  let loose: Todo[] = []

  const flush = () => {
    if (loose.length) {
      phases.push({ id: `loose:${loose[0]?.id ?? ''}`, items: loose.map(item) })
      loose = []
    }
  }

  for (const t of todos) {
    if (rootOf(t) !== t) {
      continue
    }

    const kids = under.get(t.id)

    if (!kids) {
      loose.push(t)

      continue
    }

    flush()
    phases.push({ collapsed: kids.every(k => k.status === 'completed'), id: `parent:${t.id}`, items: kids.map(item), title: t.content })
  }

  flush()

  return phases
}

/** A linear projection also tolerates old or malformed snapshots. */
function nestedPhases(todos: Todo[]) {
  // An ambiguous duplicate cannot safely identify a parent. Keep both rows and
  // disclose the unresolved reference instead of attaching it to the wrong row.
  const byId = new Map<string, number | null>()
  todos.forEach((t, i) => byId.set(t.id, byId.has(t.id) ? null : i))
  return [{
    id: 'all',
    items: todos.map((t, i) => {
      const parent = t.parent ? (byId.get(t.parent) ?? -1) : -1
      const label = `${t.content} (${t.id})`

      return {
        id: `todo:${i}`,
        status: TODO_LOOK[t.status].item,
        text: t.parent
          ? `${label} — ${parent >= 0 ? `under ${todos[parent]?.content} (${t.parent})` : `parent unavailable (${t.parent})`}`
          : label
      }
    })
  }]
}
