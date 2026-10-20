// The agent's todo list as its todo tool calls leave it: a call's whole list, or a merge that
// patches the one before, and the newest snapshot in a transcript.

import type { ChecklistStatus } from '@stencil-hq/tern'

import type { Entry, Todo } from '../model.js'
import { record } from '../wire/json.js'

/** How a todo's status looks: its item's state in Tern's `checklist`. */
export interface TodoLook {
  item: ChecklistStatus
}

/** Each todo status's look. */
export const TODO_LOOK = {
  cancelled: { item: 'dropped' },
  completed: { item: 'done' },
  in_progress: { item: 'active' },
  pending: { item: 'pending' }
} as const satisfies Record<Todo['status'], TodoLook>

/** Done and total (cancelled ones drop out), and the item under way (else the next one). */
export function todoProgress(list: readonly Todo[]): { done: number; total: number; current: string } {
  const live = list.filter(t => t.status !== 'cancelled')
  const done = live.filter(t => t.status === 'completed').length
  const current = live.find(t => t.status === 'in_progress') ?? live.find(t => t.status === 'pending')

  return { current: current?.content ?? '', done, total: live.length }
}

/** The agent's todo list as its newest snapshot in `entries` left it (any turn), if it ever made one. */
export function currentTodos(entries: readonly Entry[]): Todo[] | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]

    if (e?.kind !== 'turn') {
      continue
    }

    const hit = e.blocks.findLast(b => b.kind === 'tool' && b.call.todos?.length)

    if (hit?.kind === 'tool') {
      return hit.call.todos
    }
  }

  return undefined
}

/** A todo call's list from its args: the whole list, or with `merge: true` a patch on `current`. */
export function todosOf(args: Record<string, unknown>, current: Todo[] | undefined): Todo[] {
  const raw = Array.isArray(args.todos) ? args.todos : []

  return args.merge === true ? mergeTodos(current ?? [], raw) : toTodos(raw)
}

/** As TodoStore.write(merge=True): items update by id in the fields given, new ids append. */
function mergeTodos(current: Todo[], patch: unknown[]): Todo[] {
  const out = current.map(t => ({ ...t }))

  for (const item of patch) {
    const r = record(item)
    const id = String(r?.id ?? '').trim()

    if (!r || !id) {
      continue
    }

    const cur = out.find(t => t.id === id)

    if (!cur) {
      // Hermes rejects a new item with no text, so it never joins the list.
      if (String(r.content ?? '').trim()) {
        out.push(...toTodos([{ ...r, id }]))
      }

      continue
    }

    const content = String(r.content ?? '').trim()
    const status = String(r.status ?? '').trim().toLowerCase()

    if (content) {
      cur.content = content
    }

    if (status === 'pending' || status === 'in_progress' || status === 'completed' || status === 'cancelled') {
      cur.status = status
    }

    if ('parent' in r) {
      const parent = String(r.parent ?? '').trim()

      if (parent && parent !== id) {
        cur.parent = parent
      } else {
        delete cur.parent
      }
    }
  }

  return out
}

/** A todo snapshot's items as the list holds them: an unknown status is pending. */
export function toTodos(raw: unknown[]): Todo[] {
  const out: Todo[] = []

  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue
    }

    const id = 'id' in item ? String(item.id) : String(out.length)
    const content = 'content' in item ? String(item.content) : ''
    const status = 'status' in item ? String(item.status) : 'pending'
    const parent = 'parent' in item && item.parent ? String(item.parent) : undefined

    out.push({
      content,
      id,
      ...(parent && { parent }),
      status: status === 'completed' || status === 'in_progress' || status === 'cancelled' ? status : 'pending'
    })
  }

  return out
}
