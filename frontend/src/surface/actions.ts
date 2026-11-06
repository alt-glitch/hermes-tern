// The Tern events no node handler took, as data: ACTIONS maps each `act` name the pane's nodes
// send with a value to what it does, and a focus on the composer's input hands it the keys back.

import type { TspEvent } from '@stencil-hq/tern'

import type { ConnectWatcher } from '../connections/watcher.js'

import { INPUT_ID } from './host.js'

/** What the actions and the composer's focus reach of the app. */
export interface ActionCx {
  /** Shows subagent `id` beside the chat, or in its timeline sheet. */
  openAgent(id: string): void
  /** The Background sheet at process `id`. */
  openProcess(id: string): void
  /** `url` in the browser. */
  openUrl(url: string): void
  readonly connect: Pick<ConnectWatcher, 'approve' | 'continue' | 'open' | 'retry' | 'skip'>
  /** A modal sheet is on top: the composer's input does not take the keys back. */
  modal(): boolean
  /** The composer's input took Tern's focus: the pills let go of the keys, and the caret stays there. */
  focusComposer(): void
}

/** The `act` names with a handler here. */
export type ActionName =
  | 'connect-approve'
  | 'connect-continue'
  | 'connect-open'
  | 'connect-retry'
  | 'connect-skip'
  | 'open-agent'
  | 'open-process'
  | 'open-url'

/** What an action does with its (non-empty) value. */
type ActionHandler = (value: string, cx: ActionCx) => void

/** A connect card row's action value, `<card>:<app>`: the card names the row, as call ids repeat. */
function cardRow(value: string): [string, string] {
  const at = value.lastIndexOf(':')

  return [value.slice(0, at), value.slice(at + 1)]
}

/** Each action's handler. */
export const ACTIONS = {
  // A live connect card's Connect on an MCP row: the gateway installs it.
  'connect-approve': (value, cx) => cx.connect.approve(...cardRow(value)),
  // A connect card's Continue.
  'connect-continue': (value, cx) => cx.connect.continue(value),
  // A connect card's Authorize: the app's link in the browser.
  'connect-open': (value, cx) => cx.connect.open(...cardRow(value)),
  // A live connect card's Try again on a failed or expired link.
  'connect-retry': (value, cx) => cx.connect.retry(...cardRow(value)),
  // A live connect card's Skip on one app.
  'connect-skip': (value, cx) => cx.connect.skip(...cardRow(value)),
  'open-agent': (value, cx) => cx.openAgent(value),
  'open-process': (value, cx) => cx.openProcess(value),
  // A connect card's Authorize: the app's link in the browser.
  'open-url': (value, cx) => cx.openUrl(value)
} satisfies Record<ActionName, ActionHandler>

/** Whether `act` has a handler in ACTIONS. */
const isActionName = (act: string): act is ActionName => Object.hasOwn(ACTIONS, act)

/** Runs a Tern event no node handler took: an action with a value, or the composer's focus. */
export function onTernEvent(ev: TspEvent, cx: ActionCx) {
  if (ev.ev === 'action' && ev.value && isActionName(ev.act)) {
    return ACTIONS[ev.act](ev.value, cx)
  }

  if (ev.ev === 'focus' && ev.id === INPUT_ID && !cx.modal()) {
    cx.focusComposer()
  }
}
