// The agents hub's state: the tab, the picked agent, whether one agent's timeline is open, and
// what the search line or the confirm bar is doing over it. A key (hubKey) and a click
// (HUB_CLICKS) become the same HubAction, and reduceHub gives the next state and the one effect
// the sheet runs for it (close, open beside, steer, stop, pause, read a log). The reducer is pure:
// it reads the agents from the list the sheet passes in.

import type { Key } from '@stencil-hq/tern'

import type { Subagent } from '../model.js'
import { editQuery, moveSelection } from '../overlays/search.js'

import { isRunning } from './rows.js'

export type HubTab = 'all' | 'running'

/** The agent list, or one agent's timeline with its selected step (undefined follows the newest). */
export type HubView = { kind: 'list' } | { kind: 'timeline'; agent: string; step: string | undefined }

/** What the search line or the confirm bar does over the view: one at a time. */
export type HubAsk = { kind: 'none' } | { kind: 'steering'; text: string } | { kind: 'confirmStop' }

export interface HubState {
  readonly tab: HubTab
  /** The agent picked in the list. */
  readonly selected: string | undefined
  readonly view: HubView
  readonly ask: HubAsk
}

/** What a key or a click asks of the hub. */
export type HubAction =
  /** Esc or Close: the timeline goes back to the list; the list closes the hub. */
  | { type: 'back' }
  | { type: 'tab'; tab: HubTab }
  /** A row of the list. */
  | { type: 'select'; id: string }
  /** A step of the timeline. */
  | { type: 'step'; id: string }
  /** The list moved past the picked agent (a tab hides it): the first listed one is picked. */
  | { type: 'listed'; ids: readonly string[] }
  /** Opens the picked agent's timeline. */
  | { type: 'watch' }
  /** Opens agent `id` (else the picked one) beside the chat. */
  | { type: 'beside'; id?: string }
  | { type: 'pause' }
  | { type: 'steer' }
  | { type: 'steerEdit'; text: string }
  | { type: 'steerCancel' }
  | { type: 'steerSend' }
  | { type: 'stop' }
  | { type: 'stopCancel' }
  | { type: 'stopConfirm' }

/** What the sheet runs after an action: the parts that reach outside the hub. */
export type HubEffect =
  | { kind: 'close' }
  | { kind: 'beside'; id: string }
  /** Reads the agent's live log again, for its timeline. */
  | { kind: 'refresh'; agent: Subagent }
  | { kind: 'steer'; agent: Subagent; text: string }
  | { kind: 'stop'; agent: Subagent }
  | { kind: 'pause' }

/** The next state, and the effect to run for the action, if any. */
export interface HubStep {
  state: HubState
  effect?: HubEffect
}

const NONE: HubAsk = { kind: 'none' }
const LIST: HubView = { kind: 'list' }

/** The hub as it opens: on agent `focus` when given, else the first running one; Running when any runs. */
export function initialHub(agents: readonly Subagent[], focus?: string): HubState {
  return {
    ask: NONE,
    selected: focus ?? agents.find(isRunning)?.id ?? agents[0]?.id,
    tab: agents.some(isRunning) ? 'running' : 'all',
    view: LIST
  }
}

/** The agent the hub acts on: the one whose timeline is open, else the picked one. */
export function currentAgent(state: HubState, agents: readonly Subagent[]): Subagent | undefined {
  const id = state.view.kind === 'timeline' ? state.view.agent : state.selected

  return agents.find(a => a.id === id)
}

/** The agents the tab lists. */
export function shownAgents(state: HubState, agents: readonly Subagent[]): Subagent[] {
  return state.tab === 'running' ? agents.filter(isRunning) : [...agents]
}

/** The ids of `a`'s timeline steps, oldest first. */
export function stepIds(a: Subagent): string[] {
  return (a.log?.entries ?? []).map((_, i) => `e${i}`)
}

const running = (a: Subagent | undefined): a is Subagent => Boolean(a && isRunning(a))

/** The state after `action`, and what the sheet runs for it. */
export function reduceHub(state: HubState, action: HubAction, agents: readonly Subagent[]): HubStep {
  const a = currentAgent(state, agents)

  switch (action.type) {
    case 'back':
      return state.view.kind === 'timeline'
        ? { state: { ...state, selected: state.view.agent, view: LIST } }
        : { effect: { kind: 'close' }, state }

    case 'tab':
      return { state: { ...state, tab: action.tab } }

    case 'select':
      return { state: { ...state, ask: state.ask.kind === 'confirmStop' ? NONE : state.ask, selected: action.id } }

    case 'step': {
      if (state.view.kind !== 'timeline' || !a) {
        return { state }
      }

      // Back on the newest step: follow again.
      const step = action.id === stepIds(a).at(-1) ? undefined : action.id

      return { state: { ...state, view: { ...state.view, step } } }
    }

    case 'listed':
      return action.ids.some(id => id === state.selected) ? { state } : { state: { ...state, selected: action.ids[0] } }

    case 'watch': {
      const picked = agents.find(x => x.id === state.selected)

      return picked
        ? { effect: { agent: picked, kind: 'refresh' }, state: { ...state, view: { agent: picked.id, kind: 'timeline', step: undefined } } }
        : { state }
    }

    case 'beside': {
      const id = action.id ?? state.selected

      return id ? { effect: { id, kind: 'beside' }, state } : { state }
    }

    case 'pause':
      return { effect: { kind: 'pause' }, state }

    case 'steer':
      return running(a) ? { state: { ...state, ask: { kind: 'steering', text: '' } } } : { state }

    case 'steerEdit':
      return state.ask.kind === 'steering' ? { state: { ...state, ask: { kind: 'steering', text: action.text } } } : { state }

    case 'steerCancel':
      return { state: state.ask.kind === 'steering' ? { ...state, ask: NONE } : state }

    case 'steerSend': {
      const text = state.ask.kind === 'steering' ? state.ask.text.trim() : ''
      const next = { ...state, ask: state.ask.kind === 'steering' ? NONE : state.ask }

      return a && text ? { effect: { agent: a, kind: 'steer', text }, state: next } : { state: next }
    }

    case 'stop':
      return running(a) ? { state: { ...state, ask: { kind: 'confirmStop' } } } : { state }

    case 'stopCancel':
      return { state: state.ask.kind === 'confirmStop' ? { ...state, ask: NONE } : state }

    case 'stopConfirm': {
      const next = state.ask.kind === 'confirmStop' ? { ...state, ask: NONE } : state

      return running(a) ? { effect: { agent: a, kind: 'stop' }, state: next } : { state: next }
    }
  }
}

/** The action key `k` asks for, or undefined when the hub ignores it (it takes every key regardless). */
export function hubKey(state: HubState, k: Key, agents: readonly Subagent[]): HubAction | undefined {
  const { ask, view } = state

  if (ask.kind === 'steering') {
    if (k.name === 'escape') {
      return { type: 'steerCancel' }
    }

    if (k.name === 'enter') {
      return { type: 'steerSend' }
    }

    const text = editQuery(k, ask.text)

    return text === undefined ? undefined : { text, type: 'steerEdit' }
  }

  if (ask.kind === 'confirmStop') {
    return k.name === 'enter' || k.name === 'y'
      ? { type: 'stopConfirm' }
      : k.name === 'escape' || k.name === 'n'
        ? { type: 'stopCancel' }
        : undefined
  }

  const a = currentAgent(state, agents)
  const bare = !k.ctrl && !k.alt

  if (k.name === 'escape') {
    return { type: 'back' }
  }

  if (k.name === 's' && bare && running(a)) {
    return { type: 'steer' }
  }

  if (k.name === 'x' && bare && running(a)) {
    return { type: 'stop' }
  }

  if (view.kind === 'timeline' && a) {
    const ids = stepIds(a)
    const moved = moveSelection(k, ids, view.step ?? ids.at(-1))

    return moved === undefined ? undefined : { id: moved, type: 'step' }
  }

  if (k.name === 'enter') {
    return { type: 'beside' }
  }

  if (k.name === 't' && bare) {
    return { type: 'watch' }
  }

  if (k.name === 'p' && bare) {
    return { type: 'pause' }
  }

  if (k.name === 'tab') {
    return { tab: state.tab === 'running' ? 'all' : 'running', type: 'tab' }
  }

  const moved = moveSelection(
    k,
    shownAgents(state, agents).map(x => x.id),
    state.selected
  )

  return moved === undefined ? undefined : { id: moved, type: 'select' }
}

/** The action each of the hub's buttons asks for, by its action id. */
export const HUB_CLICKS = {
  beside: () => ({ type: 'beside' }),
  cancel: () => ({ type: 'stopCancel' }),
  close: () => ({ type: 'back' }),
  confirm: () => ({ type: 'stopConfirm' }),
  pause: () => ({ type: 'pause' }),
  steer: () => ({ type: 'steer' }),
  'steer-cancel': () => ({ type: 'steerCancel' }),
  'steer-send': () => ({ type: 'steerSend' }),
  stop: () => ({ type: 'stop' }),
  tab: ev => ({ tab: ev.value === 'running' ? 'running' : 'all', type: 'tab' }),
  watch: () => ({ type: 'watch' })
} satisfies Record<string, (ev: { value?: string }) => HubAction>
