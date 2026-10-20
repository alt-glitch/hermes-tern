// Every other tool: a card named for the omp tool it resembles, its result as code; and the
// readings of a call (its error, a readable name, its result as text) the other cards share.

import type { JSX } from '@stencil-hq/tern'

import { shownImage } from '../../../media.js'
import type { ToolCall } from '../../../model.js'
import { tilesNode } from '../../../processes/widgets/view.js'
import { isProcessTool, isWatchCall } from '../../../transcript/calls.js'
import { record } from '../../../wire/json.js'
import { commandLine } from '../../describe.js'
import { clip, nonEmpty } from '../../format.js'
import type { Card } from '../types.js'

import { imageCard } from './image.js'

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

/**
 * A tool no other card family takes: the process, browser, vision and image tools by the omp
 * tool they resemble, anything else by its own name. An image call shows its image; a process
 * wait, poll or log its process's chart; the rest their result, folded.
 */
export function genericCard(call: ToolCall, result: Record<string, unknown> | undefined): Card {
  const look = isProcessTool(call.name)
    ? { name: 'terminal', title: PROCESS_ACTIONS[String(call.args.action)] ?? 'Process' }
    : call.name.startsWith('browser')
    ? { name: 'browser', title: humanize(call.name.replace(/^browser_?/, '')) || 'Browser' }
    : call.name === 'session_search'
      ? { name: 'search', title: 'Session search' }
      : call.name === 'vision_analyze'
        ? { name: 'image', title: 'Vision' }
        : call.name === 'image_generate'
          ? { name: 'image', title: 'Image' }
          : { name: call.name, title: humanize(call.name) }

  const src = shownImage(call)

  if (src || call.name === 'image_generate') {
    return imageCard(call, result, look, src)
  }

  // A process wait, poll or log shows its process's chart, as omp's `wait` card tiles its jobs.
  const chart = isWatchCall(call) && call.process?.chart ? tilesNode([{ process: call.process, view: call.process.chart }]) : undefined

  return {
    ...look,
    body: [...(chart ? [chart] : []), ...genericBody(call)],
    folded: !chart,
    frame: 'inline',
    target: (isProcessTool(call.name) && call.process ? commandLine(call.process.command) : undefined) ?? nonEmpty(call.args.query) ?? nonEmpty(call.args.url) ?? (call.context || undefined),
    targetKind: nonEmpty(call.args.url) ? 'path' : nonEmpty(call.args.query) ? 'query' : 'text'
  }
}

/** A settled call's result as code: JSON highlighted as JSON, clipped. */
export function genericBody(call: ToolCall): JSX.Element[] {
  const text = call.resultText ?? (call.result === undefined ? undefined : pretty(call.result))

  if (!text || call.status === 'running') {
    return []
  }

  return [<code key="out" lang={/^\s*[[{]/.test(text) ? 'json' : 'text'} text={clip(text, { mark: 'line', max: 4000 })} />]
}

/** Why a failed call failed: its result's error, its summary, or a bare string result. */
export function errorOf(call: ToolCall): string | undefined {
  const result = record(call.result)

  return (
    nonEmpty(result?.error) ?? nonEmpty(call.summary) ?? (typeof call.result === 'string' && !result ? call.result : undefined)
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
