// Tool calls as Tern `tool` nodes, in omp's vocabulary: Tern styles a tool by
// its `name` (bash, read, edit, write, grep, glob, web_search, todo, task, ask,
// eval pick the icon and the layout), so each hermes tool maps onto the omp
// tool it resembles, with the same props and body shapes omp sends. The shell
// asks the registry (registry.ts) for a call's view and wraps its card in the
// `tool` node; what only one tool knows, it asks through the view's hooks. A
// view that throws gives the generic card (registry.ts withView), and the pane
// hears of it once per tool name (faults.ts).

import type { JSX } from '@stencil-hq/tern'

import { optional } from '../../core/assert.js'
import type { ToolCall } from '../../model.js'
import { tookMs } from '../../transcript/calls.js'
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
  const status = card.status ?? call.outcome.kind
  const running = status === 'running'
  const body = [...card.body]
  const error = call.outcome.kind === 'error' ? whyFailed(call) : undefined

  if (call.outcome.kind === 'cancelled') {
    body.push(
      <text
        key="cancelled"
        role="omp.tool.notice"
        spans={[{ s: 'muted', t: `Interrupted by user after ${duration(call.outcome.duration)}` }]}
      />
    )
  }

  // A failure with output unfolds to show it (omp's failed bash); one without
  // says why in the head (omp's failed read).
  const collapsed = call.outcome.kind === 'error' ? false : card.folded

  // boundary: Tern's ToolProps has no `lang` yet (an upstream ask), so it rides in one unchecked spread.
  const lang = { lang: card.lang }

  return (
    <tool
      key={call.id}
      {...optional('age', running ? age(call, call.startedAt, now) : undefined)}
      {...optional('badges', card.badges)}
      {...optional('collapsed', body.length > 0 ? collapsed : undefined)}
      {...optional('collapsible', body.length > 0 ? true : undefined)}
      {...optional('exit', !running && call.outcome.kind !== 'cancelled' ? view.exit() : undefined)}
      {...optional('frame', card.frame === 'inline' && (running || !body.length || !card.framedWithBody) ? 'inline' : undefined)}
      {...lang}
      {...optional('meta', card.meta?.length ? card.meta : undefined)}
      name={card.name}
      {...optional('note', call.outcome.kind === 'cancelled' ? 'cancelled' : error && !card.body.length ? error : undefined)}
      {...optional('preview', card.preview)}
      {...optional('role', card.role)}
      status={status}
      {...optional('target', card.target)}
      {...optional('targetKind', card.target ? card.targetKind : undefined)}
      title={card.title}
      {...optional('took', running ? undefined : (card.took ?? tookMs(call)))}
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

  const exit = call.outcome.kind !== 'running' ? view.exit() : undefined

  if (exit) {
    body.push(<text key="exit" spans={[{ s: 'error', t: `exit ${exit}` }]} />)
  }

  const error = call.outcome.kind === 'error' && !card.body.length ? whyFailed(call) : undefined

  if (error) {
    body.push(<text key="err" role="omp.tool.error" spans={[{ s: 'error', t: error }]} wrap="word" />)
  }

  if (call.outcome.kind === 'cancelled') {
    body.push(<text key="cancelled" spans={[{ s: 'muted', t: `Interrupted by user after ${duration(call.outcome.duration)}` }]} />)
  }

  return body
}
