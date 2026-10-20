// The Background sheet's state: the tab, the picked process and cron job, whether the output
// has the whole sheet, and the stop or remove question it asks. A key (sheetKey) and a click (SHEET_CLICKS) become the same SheetAction, and
// reduceSheet gives the next state and the one effect the sheet runs for it (close, stop one or
// all, act on a job, copy). The reducer is pure: it reads the processes and jobs from the facts
// the sheet passes in.

import type { Key } from '@stencil-hq/tern'

import type { BackgroundProcess } from '../model.js'
import { moveSelection } from '../overlays/search.js'

import { type CronAction, type CronJob, isPaused } from './cron.js'
import { isRunning } from './store.js'

export type SheetTab = 'all' | 'cron' | 'running'

export const SHEET_TABS: readonly SheetTab[] = ['running', 'all', 'cron']

/** What the sheet asks before it acts: stop the picked process, stop them all, remove the picked job. */
export type SheetConfirm = 'all' | 'job' | 'one'

export interface SheetState {
  readonly tab: SheetTab
  /** The process picked on the Running and All tabs. */
  readonly selected: string | undefined
  /** The job picked on the Cron tab. */
  readonly job: string | undefined
  /** Enter: the output takes the whole sheet. */
  readonly expanded: boolean
  readonly confirm: SheetConfirm | undefined
}

/** What the reducer reads of the stores. */
export interface SheetFacts {
  readonly processes: readonly BackgroundProcess[]
  readonly jobs: readonly CronJob[]
  /** Whether a stop of process `id` is in flight. */
  stopping(id: string): boolean
  /** Whether an action on job `id` is in flight. */
  busy(id: string): boolean
}

/** What a key or a click asks of the sheet. */
export type SheetAction =
  /** Esc or Close: the output goes back to the list; the list closes the sheet. */
  | { type: 'back' }
  | { type: 'tab'; tab: SheetTab }
  | { type: 'select'; id: string }
  | { type: 'selectJob'; id: string }
  /** The tab moved past the picked process or job (a tab hides it): the first listed one is picked. */
  | { type: 'listed'; ids: readonly string[] }
  | { type: 'jobsListed'; ids: readonly string[] }
  /** Enter or Output: the output takes the sheet, or gives it back. */
  | { type: 'expand' }
  /** A row activated: its output takes the sheet. */
  | { type: 'activate'; id: string }
  | { type: 'ask'; what: 'all' | 'one' }
  | { type: 'askRemove' }
  | { type: 'toggleJob' }
  | { type: 'cancel' }
  | { type: 'confirm' }
  | { type: 'copy' }

/** What the sheet runs after an action: the parts that reach outside it. */
export type SheetEffect =
  | { kind: 'close' }
  | { kind: 'stopOne'; process: BackgroundProcess }
  | { kind: 'stopAll' }
  | { kind: 'job'; action: CronAction; job: CronJob }
  /** Copies process `id`'s command; the sheet marks its button for a moment. */
  | { kind: 'copy'; command: string; id: string }

/** The next state, and the effect to run for the action, if any. */
export interface SheetStep {
  state: SheetState
  effect?: SheetEffect
}

/** The sheet as it opens: on process `at` when given (its tab), on the Cron tab for `{ tab: 'cron' }`. */
export function initialSheet(processes: readonly BackgroundProcess[], at?: string | { tab: 'cron' }): SheetState {
  const focus = typeof at === 'string' ? at : undefined
  const focused = focus ? processes.find(p => p.id === focus) : undefined
  const tab: SheetTab =
    typeof at === 'object' ? at.tab : focused ? (isRunning(focused) ? 'running' : 'all') : processes.some(isRunning) ? 'running' : 'all'

  return {
    confirm: undefined,
    expanded: false,
    job: undefined,
    selected: focus ?? processes.find(isRunning)?.id ?? processes[0]?.id,
    tab
  }
}

/** The processes the tab lists. */
export function shownProcesses(state: SheetState, processes: readonly BackgroundProcess[]): BackgroundProcess[] {
  return state.tab === 'running' ? processes.filter(isRunning) : [...processes]
}

/** The picked process, on any tab. */
export function currentProcess(state: SheetState, facts: SheetFacts): BackgroundProcess | undefined {
  return facts.processes.find(p => p.id === state.selected)
}

/** The picked cron job. */
export function currentJob(state: SheetState, facts: SheetFacts): CronJob | undefined {
  return facts.jobs.find(j => j.job_id === state.job)
}

/** The tab after `tab` (before it, `back`), wrapping. */
function nextTab(tab: SheetTab, back: boolean): SheetTab {
  return SHEET_TABS[(SHEET_TABS.indexOf(tab) + (back ? SHEET_TABS.length - 1 : 1)) % SHEET_TABS.length] ?? tab
}

/** The state after `action`, and what the sheet runs for it. */
export function reduceSheet(state: SheetState, action: SheetAction, facts: SheetFacts): SheetStep {
  const settled = { ...state, confirm: undefined }

  switch (action.type) {
    case 'back':
      return state.expanded ? { state: { ...state, expanded: false } } : { effect: { kind: 'close' }, state }

    case 'tab':
      return { state: { ...settled, expanded: false, tab: action.tab } }

    case 'select':
      return { state: { ...settled, selected: action.id } }

    case 'selectJob':
      return { state: { ...settled, job: action.id } }

    case 'listed':
      return action.ids.some(id => id === state.selected) ? { state } : { state: { ...state, selected: action.ids[0] } }

    case 'jobsListed':
      return action.ids.some(id => id === state.job) ? { state } : { state: { ...state, job: action.ids[0] } }

    case 'expand':
      return { state: { ...state, expanded: Boolean(currentProcess(state, facts)) && !state.expanded } }

    case 'activate':
      return { state: { ...state, expanded: true, selected: action.id } }

    case 'ask': {
      const p = currentProcess(state, facts)
      const can = action.what === 'one' ? Boolean(p && isRunning(p) && !facts.stopping(p.id)) : facts.processes.some(isRunning)

      return can ? { state: { ...state, confirm: action.what } } : { state }
    }

    case 'askRemove':
      return currentJob(state, facts) ? { state: { ...state, confirm: 'job' } } : { state }

    case 'toggleJob': {
      const j = currentJob(state, facts)

      if (!j) {
        return { state }
      }

      return facts.busy(j.job_id)
        ? { state: settled }
        : { effect: { action: isPaused(j) ? 'resume' : 'pause', job: j, kind: 'job' }, state: settled }
    }

    case 'cancel':
      return { state: settled }

    case 'confirm':
      return { state: settled, ...confirmed(state, facts) }

    case 'copy': {
      const p = currentProcess(state, facts)

      return p ? { effect: { command: p.command, id: p.id, kind: 'copy' }, state } : { state }
    }
  }
}

/** The effect the open question's yes runs (a stop of the picked process when none is open). */
function confirmed(state: SheetState, facts: SheetFacts): { effect?: SheetEffect } {
  if (state.confirm === 'all') {
    return { effect: { kind: 'stopAll' } }
  }

  if (state.confirm === 'job') {
    const j = currentJob(state, facts)

    return j && !facts.busy(j.job_id) ? { effect: { action: 'remove', job: j, kind: 'job' } } : {}
  }

  const p = currentProcess(state, facts)

  return p && isRunning(p) ? { effect: { kind: 'stopOne', process: p } } : {}
}

/** The action key `k` asks for, or undefined when the sheet ignores it (it takes every key regardless). */
export function sheetKey(state: SheetState, k: Key, facts: SheetFacts): SheetAction | undefined {
  if (state.confirm) {
    return k.name === 'enter' || k.name === 'y' ? { type: 'confirm' } : k.name === 'escape' || k.name === 'n' ? { type: 'cancel' } : undefined
  }

  const bare = !k.ctrl && !k.alt && !k.meta

  if (k.name === 'escape') {
    return { type: 'back' }
  }

  if (state.tab === 'cron') {
    if (k.name === 'tab') {
      return { tab: nextTab(state.tab, k.shift), type: 'tab' }
    }

    if (k.name === 'p' && bare && !k.shift) {
      return { type: 'toggleJob' }
    }

    if (k.name === 'd' && bare && !k.shift) {
      return { type: 'askRemove' }
    }

    const moved = moveSelection(
      k,
      facts.jobs.map(j => j.job_id),
      state.job
    )

    return moved === undefined ? undefined : { id: moved, type: 'selectJob' }
  }

  if (k.name === 'enter') {
    return { type: 'expand' }
  }

  if (k.name === 'k' && bare) {
    return { type: 'ask', what: k.shift ? 'all' : 'one' }
  }

  if (k.name === 'c' && bare && !k.shift) {
    return { type: 'copy' }
  }

  if (k.name === 'tab' && !state.expanded) {
    return { tab: nextTab(state.tab, k.shift), type: 'tab' }
  }

  const moved = moveSelection(
    k,
    shownProcesses(state, facts.processes).map(p => p.id),
    state.selected
  )

  return moved === undefined ? undefined : { id: moved, type: 'select' }
}

/** The action each of the sheet's buttons asks for, by its action id. */
export const SHEET_CLICKS = {
  all: () => ({ type: 'ask', what: 'all' }),
  cancel: () => ({ type: 'cancel' }),
  close: () => ({ type: 'back' }),
  confirm: () => ({ type: 'confirm' }),
  copy: () => ({ type: 'copy' }),
  expand: () => ({ type: 'expand' }),
  remove: () => ({ type: 'askRemove' }),
  stop: () => ({ type: 'ask', what: 'one' }),
  tab: ev => ({ tab: SHEET_TABS.find(t => t === ev.value) ?? 'all', type: 'tab' }),
  toggle: () => ({ type: 'toggleJob' })
} satisfies Record<string, (ev: { value?: string }) => SheetAction>
