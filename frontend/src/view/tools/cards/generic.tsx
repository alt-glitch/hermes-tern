// Every other tool: the views of the tools no card family takes (the process, browser, vision,
// image and session search tools, Tool Search's lookups, the pull request tools and any unknown
// name), the generic card they draw (named for the omp tool each resembles, its result as code),
// the view the shell falls back on when a call's own view throws, and the readings of a call (its
// error, a readable name, its result as text) the cards share.

import type { JSX } from '@stencil-hq/tern'

import { appOf } from '../../../bridge.js'
import { shownImage } from '../../../media.js'
import type { ToolCall } from '../../../model.js'
import { tilesNode } from '../../../processes/widgets/view.js'
import { resultOf } from '../../../tools/detail.js'
import type { GenericFields, PullRequestDetail } from '../../../tools/misc.js'
import { isWatchCall } from '../../../transcript/calls.js'
import { record } from '../../../wire/json.js'
import { commandLine } from '../../describe.js'
import { clip, nonEmpty } from '../../format.js'
import { namedStep } from '../steps.js'
import type { CallView, Card, ToolView } from '../types.js'

import { imageCard } from './image.js'

/** The omp tool a card-less call resembles: its icon and layout, and the card's title. */
interface Look {
  name: string
  title: string
}

/** A call by its own name: `session_search` reads `Session search`. */
const own = (call: ToolCall): Look => ({ name: call.name, title: humanize(call.name) })

/**
 * The view of a tool no card family takes: the generic card with `look`, a step by the tool's
 * name. Its card reads only the generic fields, so it serves every tool whose detail has them.
 */
const plain = (look: (call: ToolCall) => Look, action: ToolView<'other'>['action'] = 'other') =>
  ({ action, card: (call: ToolCall, d: GenericFields) => genericCard(call, d, look(call)), step: namedStep }) satisfies ToolView<'other'>

/** Any tool no view takes, by its own name. */
export const otherView: ToolView<'other'> = plain(own)

/** session_search: the past sessions it found. */
export const sessionSearchView: ToolView<'session_search'> = plain(() => ({ name: 'search', title: 'Session search' }))

/** vision_analyze: its answer, folded. */
export const visionView: ToolView<'vision_analyze'> = plain(() => ({ name: 'image', title: 'Vision' }))

/** image_generate: the picture asked for, even before it lands. */
export const imageGenerateView: ToolView<'image_generate'> = {
  action: 'other',
  card: (call, d) => imageCard(call, d, { name: 'image', title: 'Image' }, shownImage(call)),
  step: namedStep
}

/** The browser tools (`browser_navigate`, `browser_vision`…): a screenshot shows as its image. */
export const browserView: ToolView<'browser'> = {
  ...plain(call => ({ name: 'browser', title: humanize(call.name.replace(/^browser_?/, '')) || 'Browser' }), 'browser'),
  hubIcon: name => (name === 'browser_navigate' ? 'web' : 'wrench')
}

/** The process tool's actions as a card's title. */
const PROCESS_ACTIONS: Record<string, string> = {
  close: 'Close process input',
  kill: 'Stop process',
  list: 'List processes',
  log: 'Read process output',
  poll: 'Check process',
  submit: 'Send to process',
  wait: 'Wait for process',
  write: 'Write to process'
}

/** The process tool: omp's terminal look, headed by the process's command while the store follows it. */
export const processView: ToolView<'process_manage'> = {
  action: 'command',
  card: (call, d) => {
    const card = genericCard(call, d, { name: 'terminal', title: PROCESS_ACTIONS[d.action] ?? 'Process' })

    return { ...card, target: call.process ? commandLine(call.process.command) : card.target }
  },
  step: namedStep
}

/** Tool Search's `tool_search`: the queries it looked up. */
export const toolSearchView: ToolView<'tool_search'> = {
  ...plain(own, 'lookup'),
  step: (_call, d) => (d.queries.length ? `Searched tools for ${d.queries.join(', ')}` : 'Searched tools')
}

/** Tool Search's `tool_describe`: the tools it read about, a connector's as its app and action. */
export const toolDescribeView: ToolView<'tool_describe'> = {
  ...plain(own, 'lookup'),
  step: (_call, d) => {
    const named = d.names.map(n => {
      const app = appOf(n)

      return app ? `${app.app} · ${app.action}` : n.replace(/_/g, ' ')
    })

    return named.length ? `Read how to call ${named.join(', ')}` : 'Read tool details'
  }
}

/** `Linked owner/repo#12`: the pull request, from its URL or its repository and number. */
function pullRequestStep(verb: string, d: PullRequestDetail): string {
  const pr = d.url?.match(/github[^/]*\/(?<repo>[^/]+\/[^/]+)\/pull\/(?<number>\d+)/)?.groups
  const repo = pr?.['repo'] ?? d.repository
  const number = pr?.['number'] ?? (d.number === undefined ? undefined : String(d.number))

  return repo && number ? `${verb} ${repo}#${number}` : `${verb} a pull request`
}

/** link_pull_request: the PR it linked to the session. */
export const linkView: ToolView<'link_pull_request'> = { ...plain(own), step: (_call, d) => pullRequestStep('Linked', d) }

/** unlink_pull_request: the PR it unlinked. */
export const unlinkView: ToolView<'unlink_pull_request'> = { ...plain(own), step: (_call, d) => pullRequestStep('Unlinked', d) }

/** list_pull_requests. */
export const listPullRequestsView: ToolView<'list_pull_requests'> = { ...plain(own), step: () => 'Listed linked pull requests' }

/**
 * The generic card: a tool by the omp tool it resembles (`look`). A browser screenshot shows its
 * image; a process wait, poll or log its process's chart; the rest their result, folded.
 */
export function genericCard(call: ToolCall, d: GenericFields, look: Look): Card {
  const src = shownImage(call)

  if (src) {
    return imageCard(call, d, look, src)
  }

  // A process wait, poll or log shows its process's chart, as omp's `wait` card tiles its jobs.
  const chart = isWatchCall(call) && call.process?.chart ? tilesNode([{ process: call.process, view: call.process.chart }]) : undefined

  return {
    ...look,
    body: [...(chart ? [chart] : []), ...genericBody(call)],
    folded: !chart,
    frame: 'inline',
    target: d.query ?? d.url ?? (call.context || undefined),
    targetKind: d.url ? 'path' : d.query ? 'query' : 'text'
  }
}

/** A settled call's result as code: JSON highlighted as JSON, clipped. */
export function genericBody(call: ToolCall): JSX.Element[] {
  const text = call.resultText ?? (call.result === undefined ? undefined : pretty(call.result))

  if (!text || call.outcome.kind === 'running') {
    return []
  }

  return [<code key="out" lang={/^\s*[[{]/.test(text) ? 'json' : 'text'} text={clip(text, { mark: 'line', max: 4000 })} />]
}

/**
 * The view of a call whose own view threw: the generic card by the call's own name, its result as
 * code. It reads nothing the tool's parser reads, so it draws whatever the call holds.
 */
export function fallbackView(call: ToolCall): CallView {
  return {
    action: () => 'other',
    card: () => ({ body: genericBody(call), folded: true, frame: 'inline', name: call.name, title: humanize(call.name) }),
    detailPrefix: () => undefined,
    exit: () => undefined,
    replaces: () => undefined,
    step: () => humanize(call.name)
  }
}

/** Why a failed call failed: its result's error, its summary, or a bare string result. */
export function errorOf(call: ToolCall): string | undefined {
  return errorIn(call, resultOf(call))
}

/** errorOf without the tool's parser, for the fallback card (the parse may be what threw). */
export function plainErrorOf(call: ToolCall): string | undefined {
  return errorIn(call, record(call.result))
}

/** Why `call` failed, with `result` its result as an object. */
function errorIn(call: ToolCall, result: Record<string, unknown> | undefined): string | undefined {
  return (
    nonEmpty(result?.['error']) ?? nonEmpty(call.outcome.kind === 'running' ? undefined : call.outcome.summary) ?? (typeof call.result === 'string' && !result ? call.result : undefined)
  )
}

/** A tool name as words: `web_extract` reads `Web extract`. */
export function humanize(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim()

  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A result as text: a string as it is, anything else as indented JSON. */
export function pretty(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
}
