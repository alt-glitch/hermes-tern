// The tool registry: one view per tool (cards/*), keyed by the tool its detail names
// (tools/detail.ts). Two tests run ahead of the name: a call that acts in an app (a connector
// or MCP tool) takes the app card, and a bridge batch the batch card. Everything that once
// switched on a tool's name asks here: the shell for the card and its hooks, the work log for
// the step line and the action, the agents hub for the icon. A view that throws (a renderer bug,
// or args its parser did not expect) gives way to the generic one through withView, and the pane
// hears of it once per tool name (faults.ts).

import type { ToolCall } from '../../model.js'
import { appsOf, batchOf, type BatchEntry, callApp } from '../../tools/bridge.js'
import { type DetailOf, detailOf, type ToolKey, toolKeyOf } from '../../tools/detail.js'

import { appCard, batchCard } from './cards/app.js'
import { askView } from './cards/ask.js'
import { connectView } from './cards/connect.js'
import { patchView, writeView } from './cards/edit.js'
import { evalView } from './cards/eval.js'
import {
  browserView,
  errorOf,
  fallbackView,
  imageGenerateView,
  linkView,
  listPullRequestsView,
  otherView,
  plainErrorOf,
  processView,
  sessionSearchView,
  toolDescribeView,
  toolSearchView,
  unlinkView,
  visionView
} from './cards/generic.js'
import { memoryView, skillsView, skillView, todoView } from './cards/inline.js'
import { readView } from './cards/read.js'
import { searchView } from './cards/search.js'
import { taskView } from './cards/task.js'
import { terminalView } from './cards/terminal.js'
import { fetchView, webSearchView } from './cards/web.js'
import { cardFault } from './faults.js'
import type { Action, CallView, ToolView } from './types.js'

/** Why a failed call failed, as the view drawing it may read it. */
export type ErrorReader = (call: ToolCall) => string | undefined

/**
 * Every tool's view. Typed as the mapped type (not only checked with `satisfies`) so a read by a
 * generic key gives that key's view: bind() pairs a detail with its own tool's view.
 */
const VIEWS: { [K in ToolKey]: ToolView<K> } = {
  browser: browserView,
  clarify: askView,
  delegate_task: taskView,
  execute_code: evalView,
  image_generate: imageGenerateView,
  link_pull_request: linkView,
  list_pull_requests: listPullRequestsView,
  manage_connections: connectView,
  memory: memoryView,
  other: otherView,
  patch: patchView,
  process_manage: processView,
  read_file: readView,
  search_files: searchView,
  session_search: sessionSearchView,
  skill_view: skillView,
  skills_list: skillsView,
  terminal: terminalView,
  todo_list: todoView,
  tool_describe: toolDescribeView,
  tool_search: toolSearchView,
  unlink_pull_request: unlinkView,
  vision_analyze: visionView,
  web_extract: fetchView,
  web_search: webSearchView,
  write_file: writeView
}

/** Each action's icon: a step's, and a work group's when all its steps share the action. */
export const ACTION_ICON = {
  app: 'plug',
  browser: 'compass',
  'code-search': 'search',
  command: 'terminal',
  edit: 'pencil',
  fetch: 'globe',
  lookup: 'search',
  other: 'wrench',
  plan: 'list-checks',
  read: 'eye',
  search: 'globe'
} as const satisfies Record<Action, string>

/** `call`'s view: its app's or its batch's when a test takes it, else its tool's, with its detail. */
export function viewOf(call: ToolCall): CallView {
  return matched(call) ?? named(call)
}

/**
 * What `use` makes of `call`'s view, with the reader of why it failed that goes with that view.
 * When the view or `use` throws, `use` runs again on the generic view (fallbackView), which reads
 * nothing the tool's parser reads, and the fault is told once per tool name. Everything that draws
 * a call (its card, its detail, its step line and action in a work group) goes through here, so one
 * broken view costs its own call, not the frame.
 */
export function withView<T>(call: ToolCall, use: (view: CallView, whyFailed: ErrorReader) => T): T {
  try {
    return use(viewOf(call), errorOf)
  } catch (error) {
    cardFault(call.name, error)

    return use(fallbackView(call), plainErrorOf)
  }
}

/** The icon the agents hub shows for a step of tool `name` (it has no args to read). */
export function hubIconOf(name: string): string {
  const icon = VIEWS[toolKeyOf(name)].hubIcon

  return typeof icon === 'function' ? icon(name) : (icon ?? 'wrench')
}

function named(call: ToolCall): CallView {
  const d = detailOf(call)

  return bind(call, d.tool, d)
}

function bind<K extends ToolKey>(call: ToolCall, key: K, d: DetailOf<K>): CallView {
  const view: ToolView<K> = VIEWS[key]

  return {
    action: () => view.action,
    card: now => view.card(call, d, now),
    detailPrefix: () => view.detailPrefix?.(call, d),
    exit: () => view.exit?.(d),
    replaces: now => view.replaces?.(call, d, now),
    step: () => view.step(call, d)
  }
}

/**
 * The views a test picks ahead of the name: a connector or MCP call (a batch whose entries all
 * act in one app too) heads its card with the app; any other batch lists its entries.
 */
function matched(call: ToolCall): CallView | undefined {
  const app = callApp(call)

  if (app) {
    return { ...hookless(call), card: () => appCard(call, app), step: () => `${app.app} · ${app.action}` }
  }

  const batch = batchOf(call)

  if (batch) {
    return {
      ...hookless(call),
      card: () => batchCard(call, batch),
      step: () => batch.map(e => viewOf(entryCall(call, e)).step()).join(', ')
    }
  }

  return undefined
}

/** A batch entry as a call of its own: the batch's call with the entry's tool and args. */
function entryCall(call: ToolCall, e: BatchEntry): ToolCall {
  return { ...call, args: e.args, name: e.name, via: { kind: 'bridged' } }
}

/** What an app or batch view shares: no hooks, and `app` while every call it made acts in an app, else its tool's action. */
function hookless(call: ToolCall): Omit<CallView, 'card' | 'step'> {
  return {
    action: () => (appsOf(call).length ? 'app' : named(call).action()),
    detailPrefix: () => undefined,
    exit: () => undefined,
    replaces: () => undefined
  }
}
