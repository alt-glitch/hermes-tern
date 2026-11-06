import type { ChecklistPhase, NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import type { Todo } from '../model.js'
import { toolNode } from '../view/tools/shell.js'
import { checklistNode, todoPanelNode, todoPhases } from '../view/todos.js'
import { call } from './toolFixtures.js'
import { spanTexts, tree } from './fakes.js'

const todo = (id: string, status: Todo['status'], parent?: string): Todo => ({ content: `item ${id}`, id, status, ...(parent && { parent }) })

/** Each phase as its title (or `-` when untitled) and its items' ids. */
const shape = (phases: readonly ChecklistPhase[]) => phases.map(p => [p.title ?? '-', (p.items ?? []).map(i => i.id)])

/** Every node under `n` with role `role`. */
const byRole = (n: NodeJson, role: string): NodeJson[] => [...(n.p?.['role'] === role ? [n] : []), ...(n.c ?? []).flatMap(c => byRole(c, role))]

// A plan as long as a real one: done, active, pending and cancelled items, a parent with subtasks
// (one of them nested a level deeper), and items between that have neither.
const LONG: Todo[] = [
  todo('a', 'completed'),
  todo('b', 'in_progress'),
  todo('c', 'pending'),
  todo('c1', 'completed', 'c'),
  todo('c2', 'in_progress', 'c'),
  todo('c2a', 'pending', 'c2'),
  todo('c3', 'cancelled', 'c'),
  todo('d', 'pending'),
  todo('e', 'cancelled')
]

describe('todoPhases', () => {
  it('keeps a flat list as one untitled phase', () => {
    expect(shape(todoPhases([todo('1', 'completed'), todo('2', 'pending')]))).toEqual([['-', ['1', '2']]])
  })

  it('shows each item once: a parent heads its subtasks, the items between sit in untitled runs', () => {
    expect(shape(todoPhases(LONG))).toEqual([
      ['-', ['a', 'b']],
      ['item c', ['c1', 'c2', 'c2a', 'c3']],
      ['-', ['d', 'e']]
    ])
  })

  it('folds a parent whose subtasks are all done', () => {
    const phases = todoPhases([todo('p', 'pending'), todo('k1', 'completed', 'p'), todo('k2', 'completed', 'p'), todo('q', 'pending')])
    expect(phases.map(p => p.collapsed ?? false)).toEqual([true, false])
  })

  it('keeps an item whose parent is missing, or in a cycle, at the top', () => {
    expect(shape(todoPhases([todo('x', 'pending', 'gone'), todo('y', 'pending')]))).toEqual([['-', ['x', 'y']]])
    expect(shape(todoPhases([todo('m', 'pending', 'n'), todo('n', 'pending', 'm')])).flatMap(([, ids]) => ids)).toEqual(['m', 'n'])
  })
})

describe('checklistNode', () => {
  it('draws one checklist per phase, so Tern heads no untitled phase', () => {
    const n = tree(checklistNode(LONG))
    expect(n.k).toBe('col')
    const phases = (c: NodeJson) => {
      const list = c.p?.['phases']

      return Array.isArray(list) ? list.length : 0
    }
    expect(n.c?.map(c => [c.k, phases(c)])).toEqual([
      ['checklist', 1],
      ['checklist', 1],
      ['checklist', 1]
    ])
  })

  it('draws a flat list as the one checklist it was', () => {
    expect(tree(checklistNode([todo('1', 'pending')])).k).toBe('checklist')
  })
})

describe('todoPanelNode', () => {
  it('heads the list with the done count, as the pill counts it (cancelled items drop out)', () => {
    const n = tree(todoPanelNode(LONG))
    const [head] = byRole(n, 'hermes.todos.head')
    expect(head?.c?.flatMap(c => spanTexts(c.p?.['spans']))).toEqual(['Todos', '2 of 7 done'])
    expect(byRole(n, 'hermes.todos.list')).toHaveLength(1)
  })

  it('draws the panel as before', async () => {
    await expect(`${JSON.stringify(tree(todoPanelNode(LONG)), null, 1)}\n`).toMatchFileSnapshot('__snapshots__/todos/panel.json')
  })
})

describe('the Todo card', () => {
  it('counts done items as the pill does: a cancelled one drops out', () => {
    const todos = [todo('1', 'completed'), todo('2', 'pending'), todo('3', 'cancelled')]
    expect(tree(toolNode(call('todo_list', { todos }, { todos }), 0)).p?.['target']).toBe('1/2')
  })
})
