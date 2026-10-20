// Tool calls as Tern `tool` nodes, in omp's vocabulary: Tern styles a tool by
// its `name` (bash, read, edit, write, grep, glob, web_search, todo, task, ask,
// eval pick the icon and the layout), so each hermes tool maps onto the omp
// tool it resembles, with the same props and body shapes omp sends. The shell
// asks the registry (registry.ts) for a call's view and wraps its card in the
// `tool` node; what only one tool knows, it asks through the view's hooks. A
// view that throws gives the generic card (registry.ts withView), and the pane
// hears of it once per tool name (faults.ts).

import type { JSX } from '@stencil-hq/tern'

import type { ToolCall } from '../../model.js'
import { duration } from '../format.js'
import { age } from '../time.js'

import { type ErrorReader, withView } from './registry.js'
import type { CallView } from './types.js'

/** The `tool` node of one call; the generic card when its view throws. */
export function toolNode(call: ToolCall, now: number): JSX.Element {
  return withView(call, (view, whyFailed) => drawTool(call, view, whyFailed, now))
}

/**
 * What a step's line opens to in a work group: its card's body without the card (a command
 * and its output, a diff, a file), and why it failed or stopped; the generic card's body when
 * its view throws.
 */
export function toolDetail(call: ToolCall, now: number): JSX.Element[] {
  return withView(call, (view, whyFailed) => drawDetail(call, view, whyFailed, now))
}

/** The `tool` node of `call` as `view` draws it. */
function drawTool(call: ToolCall, view: CallView, whyFailed: ErrorReader, now: number): JSX.Element {
  const solo = view.replaces(now)

  if (solo) {
    return solo
  }

  const card = view.card(now)
  const status = card.status ?? call.status
  const running = status === 'running'
  const body = [...card.body]
  const error = call.status === 'error' ? whyFailed(call) : undefined

  if (call.status === 'cancelled') {
    body.push(
      <text
        key="cancelled"
        role="omp.tool.notice"
        spans={[{ s: 'muted', t: `Interrupted by user after ${duration(call.duration ?? 0)}` }]}
      />
    )
  }

  // A failure with output unfolds to show it (omp's failed bash); one without
  // says why in the head (omp's failed read).
  const collapsed = call.status === 'error' ? false : card.folded

  // boundary: Tern's ToolProps has no `lang` yet (an upstream ask), so it rides in one unchecked spread.
  const lang = { lang: card.lang }

  return (
    <tool
      age={running ? age(call, call.startedAt, now) : undefined}
      badges={card.badges}
      collapsed={body.length > 0 ? collapsed : undefined}
      collapsible={body.length > 0 ? true : undefined}
      exit={!running && call.status !== 'cancelled' ? view.exit() : undefined}
      frame={card.frame === 'inline' && (running || !body.length || !card.framedWithBody) ? 'inline' : undefined}
      key={call.id}
      {...lang}
      meta={card.meta?.length ? card.meta : undefined}
      name={card.name}
      note={call.status === 'cancelled' ? 'cancelled' : error && !card.body.length ? error : undefined}
      preview={card.preview}
      role={card.role}
      status={status}
      target={card.target}
      targetKind={card.target ? card.targetKind : undefined}
      title={card.title}
      took={running ? undefined : (card.took ?? call.duration)}
    >
      {body}
    </tool>
  )
}

/** What `call`'s step opens to, as `view` draws it. */
function drawDetail(call: ToolCall, view: CallView, whyFailed: ErrorReader, now: number): JSX.Element[] {
  const card = view.card(now)
  const body = [...card.body]
  // What the card's head held and its body lacks (a short command).
  const prefix = view.detailPrefix()

  if (prefix) {
    body.unshift(prefix)
  }

  const exit = call.status !== 'running' ? view.exit() : undefined

  if (exit) {
    body.push(<text key="exit" spans={[{ s: 'error', t: `exit ${exit}` }]} />)
  }

  const error = call.status === 'error' && !card.body.length ? whyFailed(call) : undefined

  if (error) {
    body.push(<text key="err" role="omp.tool.error" spans={[{ s: 'error', t: error }]} wrap="word" />)
  }

  if (call.status === 'cancelled') {
    body.push(<text key="cancelled" spans={[{ s: 'muted', t: `Interrupted by user after ${duration(call.duration ?? 0)}` }]} />)
  }

  return body
}
