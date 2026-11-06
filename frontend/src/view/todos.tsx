// The todo list as a Tern `checklist`, as the Todo card and the dock show it.

import type { ChecklistPhase, JSX } from '@stencil-hq/tern'

import type { Todo } from '../model.js'
import { TODO_LOOK, todoProgress } from '../transcript/todos.js'

/**
 * The todos as omp's checklist. A parent with subtasks is a titled phase over them; the items with
 * neither parent nor subtasks sit in untitled phases between, so none shows twice.
 */
export function checklistNode(todos: Todo[]): JSX.Element {
  const phases = todoPhases(todos)

  if (phases.length < 2) {
    return <checklist key="list" mode="full" phases={phases} />
  }

  // One checklist per phase: Tern heads every phase of a checklist with more than one, an
  // untitled one with a bare ring and count, but leaves a lone untitled phase unheaded.
  return (
    <col key="list" role="hermes.todos.phases">
      {phases.map(ph => (
        <checklist key={ph.id ?? ''} mode="full" phases={[ph]} />
      ))}
    </col>
  )
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
    phases.push({ collapsed: kids.every(k => k.status === 'completed'), id: t.id, items: kids.map(item), title: t.content })
  }

  flush()

  return phases
}
