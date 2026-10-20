import type { Key } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { Hud, hudKey, pills, type PillSources, todos } from '../chrome/hud.js'
import type { Todo } from '../model.js'

const key = (name: string, mods: Partial<Key> = {}): Key =>
  ({ alt: false, ctrl: false, meta: false, name, shift: false, ...mods }) as Key

const both = ['agents', 'shells'] as const

describe('hudKey', () => {
  it('focuses the first pill on Down from an idle prompt only', () => {
    expect(hudKey(key('down'), { idle: true, pills: both })).toEqual({ consumed: true, focused: 'agents' })
    // A draft, history being browsed or an open completion keep Down for the composer.
    expect(hudKey(key('down'), { idle: false, pills: both })).toEqual({ consumed: false })
    expect(hudKey(key('down'), { idle: true, pills: [] })).toEqual({ consumed: false })
    expect(hudKey(key('down', { meta: true }), { idle: true, pills: both })).toEqual({ consumed: false })
    // Up stays the history key.
    expect(hudKey(key('up'), { idle: true, pills: both })).toEqual({ consumed: false })
  })

  it('moves with Left/Right, opens with Enter, and returns with Esc or Up', () => {
    const at = { focused: 'agents' as const, idle: true, pills: both }

    expect(hudKey(key('right'), at)).toEqual({ consumed: true, focused: 'shells' })
    expect(hudKey(key('left'), at)).toEqual({ consumed: true, focused: 'agents' })
    expect(hudKey(key('right'), { ...at, focused: 'shells' })).toEqual({ consumed: true, focused: 'shells' })
    expect(hudKey(key('enter'), { ...at, focused: 'shells' })).toEqual({ consumed: true, open: 'shells' })
    expect(hudKey(key('escape'), at)).toEqual({ consumed: true })
    expect(hudKey(key('up'), at)).toEqual({ consumed: true })
  })

  it('hands any other key back to the composer, and lets go of a pill that left', () => {
    const at = { focused: 'shells' as const, idle: true, pills: both }

    expect(hudKey(key('a', { text: 'a' }), at)).toEqual({ consumed: false })
    expect(hudKey(key('enter', { shift: true }), at)).toEqual({ consumed: false })
    expect(hudKey(key('enter'), { ...at, pills: ['agents'] })).toEqual({ consumed: false })
  })
})

const todo = (status: Todo['status']): Todo => ({ content: status, id: status, status })

describe('todos', () => {
  it('keeps the list while a turn runs or something on it is open', () => {
    const open = [todo('completed'), todo('pending')]
    const done = [todo('completed'), todo('cancelled')]

    expect(todos(undefined, false)).toBeUndefined()
    expect(todos([], true)).toBeUndefined()
    expect(todos(open, false)).toBe(open)
    expect(todos(done, false)).toBeUndefined()
    expect(todos(done, true)).toBe(done)
    // Cancelled ones drop out: none left is no list.
    expect(todos([todo('cancelled')], true)).toBeUndefined()
  })
})

describe('pills', () => {
  const none: PillSources = { agents: 0, busy: false, goal: false, loop: false, prs: 0, shells: 0, todos: undefined }

  it('lists the pills on show, left to right', () => {
    expect(pills(none)).toEqual([])
    expect(pills({ agents: 2, busy: false, goal: true, loop: true, prs: 1, shells: 1, todos: [todo('pending')] })).toEqual([
      'todos',
      'agents',
      'shells',
      'prs',
      'goal',
      'loop'
    ])
  })

  it('leaves the todo pill to the working line while a turn runs', () => {
    expect(pills({ ...none, busy: true, todos: [todo('pending')] })).toEqual([])
    expect(pills({ ...none, busy: true, shells: 1, todos: [todo('pending')] })).toEqual(['shells'])
  })
})

describe('Hud', () => {
  const host = () => ({ changed: vi.fn(), open: vi.fn() })

  it('focuses, moves, and opens a pill\'s sheet through the host', () => {
    const h = host()
    const hud = new Hud(h)

    expect(hud.key(key('down'), { idle: true, pills: both })).toBe(true)
    expect(hud.focused).toBe('agents')
    hud.key(key('right'), { idle: true, pills: both })
    expect(hud.focused).toBe('shells')
    expect(hud.key(key('enter'), { idle: true, pills: both })).toBe(true)
    expect(h.open).toHaveBeenCalledWith('shells')
    // Opening hands the keys back, as Enter does.
    expect(hud.focused).toBeUndefined()
  })

  it('folds the todo panel in place instead of opening a sheet', () => {
    const h = host()
    const hud = new Hud(h)

    hud.key(key('down'), { idle: true, pills: ['todos'] })
    hud.key(key('enter'), { idle: true, pills: ['todos'] })
    expect(h.open).not.toHaveBeenCalled()
    expect(hud.todosOpen).toBe(true)
    expect(h.changed).toHaveBeenCalledTimes(1)

    hud.toggleTodos()
    expect(hud.todosOpen).toBe(false)
    expect(h.changed).toHaveBeenCalledTimes(2)
  })

  it('prune() lets go of a pill that left, each frame; release() hands the keys back', () => {
    const hud = new Hud(host())

    hud.key(key('down'), { idle: true, pills: both })
    hud.prune(both)
    expect(hud.focused).toBe('agents')
    hud.prune(['shells'])
    expect(hud.focused).toBeUndefined()

    hud.key(key('down'), { idle: true, pills: both })
    hud.release()
    expect(hud.focused).toBeUndefined()
  })
})
