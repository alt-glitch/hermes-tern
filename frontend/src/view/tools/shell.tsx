// Tool calls as Tern `tool` nodes, in omp's vocabulary: Tern styles a tool by
// its `name` (bash, read, edit, write, grep, glob, web_search, todo, task, ask,
// eval pick the icon and the layout), so each hermes tool maps onto the omp
// tool it resembles, with the same props and body shapes omp sends. The shell
// picks a call's card family (cards/*) and wraps the card in its `tool` node.

import { type JSX, node } from '@stencil-hq/tern'

import { callApp } from '../../bridge.js'
import { CONNECT_TOOL, isConnectCall } from '../../connections.js'
import type { ToolCall } from '../../model.js'
import { isBackgroundCall } from '../../transcript/calls.js'
import { record } from '../../wire/json.js'
import { commandLine } from '../describe.js'
import { duration, nonEmpty } from '../format.js'
import { age } from '../time.js'

import { appCard, batchCard } from './cards/app.js'
import { askCard } from './cards/ask.js'
import { connectCard } from './cards/connect.js'
import { editCard } from './cards/edit.js'
import { evalCard } from './cards/eval.js'
import { errorOf, genericCard } from './cards/generic.js'
import { memoryCard, skillCard, skillsCard, todoCard } from './cards/inline.js'
import { readCard } from './cards/read.js'
import { searchCard } from './cards/search.js'
import { soloTask, taskCard } from './cards/task.js'
import { backgroundCard, bashCard } from './cards/terminal.js'
import { fetchCard, webSearchCard } from './cards/web.js'
import type { Card } from './types.js'

/** The `tool` node of one call. */
export function toolNode(call: ToolCall, now: number): JSX.Element {
  const solo = call.name === 'delegate_task' ? soloTask(call, now) : undefined

  if (solo) {
    return solo
  }

  const card = cardOf(call, now)
  const status = card.status ?? call.status
  const running = status === 'running'
  const body = [...card.body]
  const error = call.status === 'error' ? errorOf(call) : undefined

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

  return node(
    'tool',
    {
      age: running ? age(call, call.startedAt, now) : undefined,
      badges: card.badges,
      collapsed: body.length > 0 ? collapsed : undefined,
      collapsible: body.length > 0 ? true : undefined,
      // A background start's exit 0 only says it started; its process line tells how it ended.
      exit:
        call.name === 'terminal' && !running && call.status !== 'cancelled' && !isBackgroundCall(call) ? exitOf(call) : undefined,
      frame: card.frame === 'inline' && (running || !body.length || card.name !== 'web_search') ? 'inline' : undefined,
      key: call.id,
      lang: card.lang,
      meta: card.meta?.length ? card.meta : undefined,
      name: card.name,
      note: call.status === 'cancelled' ? 'cancelled' : error && !card.body.length ? error : undefined,
      preview: card.preview,
      role: card.role,
      status,
      target: card.target,
      targetKind: card.target ? card.targetKind : undefined,
      title: card.title,
      took: running ? undefined : (card.took ?? call.duration)
    },
    body
  )
}

/**
 * What a step's line opens to in a work group: its card's body without the card (a command
 * and its output, a diff, a file), and why it failed or stopped.
 */
export function toolDetail(call: ToolCall, now: number): JSX.Element[] {
  const card = cardOf(call, now)
  const body = [...card.body]
  const command = call.name === 'terminal' ? (nonEmpty(call.args.command) ?? call.context ?? '').trim() : ''

  // A short command sat in the card's head, so its body lacks it.
  if (command && command === commandLine(command)) {
    body.unshift(<code key="cmd" lang="bash" max={{ h: '12lines' }} role="omp.tool.command" text={command} />)
  }

  const exit = call.name === 'terminal' && call.status !== 'running' && !isBackgroundCall(call) ? exitOf(call) : undefined

  if (exit) {
    body.push(<text key="exit" spans={[{ s: 'error', t: `exit ${exit}` }]} />)
  }

  const error = call.status === 'error' && !card.body.length ? errorOf(call) : undefined

  if (error) {
    body.push(<text key="err" role="omp.tool.error" spans={[{ s: 'error', t: error }]} wrap="word" />)
  }

  if (call.status === 'cancelled') {
    body.push(<text key="cancelled" spans={[{ s: 'muted', t: `Interrupted by user after ${duration(call.duration ?? 0)}` }]} />)
  }

  return body
}

/** The card family a call takes: its app, a batch, its tool's own card, or the generic one. */
function cardOf(call: ToolCall, now: number): Card {
  const result = record(call.result)
  const app = callApp(call)

  if (app) {
    return appCard(call, app)
  }

  if (call.batch) {
    return batchCard(call, call.batch)
  }

  switch (call.name) {
    case 'terminal':
      return isBackgroundCall(call) ? backgroundCard(call, result, now) : bashCard(call, result)

    case 'read_file':
      return readCard(call, result)

    case 'patch':

    case 'write_file':
      return editCard(call, result)

    case 'search_files':
      return searchCard(call, result)

    case 'web_search':
      return webSearchCard(call, result)

    case 'web_extract':
      return fetchCard(call, result)

    case CONNECT_TOOL:
      if (isConnectCall(call)) {
        return connectCard(call)
      }

      break

    // `todo` is the legacy name stored transcripts and older backends keep.
    case 'todo':

    case 'todo_list':
      return todoCard(call)

    case 'delegate_task':
      return taskCard(call, result, now)

    case 'clarify':
      return askCard(call, result)

    case 'execute_code':
      return evalCard(call, result)

    case 'memory':
      return memoryCard(call, result)

    case 'skills_list':
      return skillsCard(result)

    case 'skill_view':
      return skillCard(call, result)
  }

  return genericCard(call, result)
}

function exitOf(call: ToolCall): number | undefined {
  const code = record(call.result)?.exit_code

  return typeof code === 'number' ? code : undefined
}
