// A turn's work the way t3code's timeline shows it (apps/web/src/components/chat/
// MessagesTimeline.logic.ts and packages/client-runtime/src/work-log/presentation.ts):
// consecutive tool calls and thoughts form one work group with a summary ("Ran 3 commands
// and read 2 files"), each step one line; a finished turn folds everything but its answer
// behind "Worked for 54s". The views in view/workLog.tsx draw what this derives.

import { appsOf, callApp } from './bridge.js'
import { isConnectCall } from './connections.js'
import { shownImage } from './media.js'
import type { Block, ToolCall, TurnEntry } from './model.js'
import { isBackgroundCall, isTodoName, isWatchCall } from './transcript/calls.js'
import { commandProgramName } from './vendor/t3code/commandLabel.js'
import { durationCompact, flat, nonEmpty, plural } from './view/format.js'
import { ACTION_ICON, withView } from './view/tools/registry.js'
import type { Action } from './view/tools/types.js'

/** A step of a work group: a tool call or a thought. */
export type WorkItem = Extract<Block, { kind: 'thinking' | 'tool' }>

/** A turn in reading order: blocks that show alone, and groups of work between them. */
export type Piece = { kind: 'block'; block: Block } | { kind: 'work'; items: WorkItem[] }

/** Calls with a view of their own: a delegation's Task card, the todo list, clarify's questions. */
const SOLO = new Set(['clarify', 'delegate_task', 'todo', 'todo_list'])

/**
 * A call that keeps its card: a solo tool, a background process with its live line, a wait on one
 * while it lasts (its chart, as omp's `wait` card), or one that shows an image (image_generate's
 * card is the picture asked for, even before it lands).
 */
export function ownsCard(call: ToolCall): boolean {
  return (
    SOLO.has(call.name) ||
    isBackgroundCall(call) ||
    waiting(call) ||
    isConnectCall(call) ||
    call.name === 'image_generate' ||
    showsImage(call)
  )
}

/** A process wait, poll or log still running. */
function waiting(call: ToolCall): boolean {
  return isWatchCall(call) && call.status === 'running'
}

/** A call with an image to show; its card stays out of the fold, so the picture is in view. */
export function showsImage(call: ToolCall): boolean {
  return shownImage(call) !== undefined
}

/**
 * Splits blocks (some of the turn's `turn`) into text, steers and card-owning calls, and the work
 * groups between them. Only the turn's newest todo list keeps its checklist card; the ones before
 * it are steps saying what they changed ("Plan updated: ✓ Write tests").
 */
export function pieces(blocks: readonly Block[], turn: readonly Block[] = blocks): Piece[] {
  const out: Piece[] = []
  let items: WorkItem[] = []
  const plan = turn.findLast(b => b.kind === 'tool' && isTodoName(b.call.name) && b.call.todos?.length)

  for (const b of blocks) {
    if (b.kind === 'thinking' || (b.kind === 'tool' && (!ownsCard(b.call) || (isTodoName(b.call.name) && b !== plan)))) {
      items.push(b)
      continue
    }

    if (items.length) {
      out.push({ items, kind: 'work' })
      items = []
    }

    out.push({ block: b, kind: 'block' })
  }

  if (items.length) {
    out.push({ items, kind: 'work' })
  }

  return out
}

/** The steps a group lists: every call, and the thoughts that say something. */
export function visibleItems(items: readonly WorkItem[]): WorkItem[] {
  return items.filter(i => i.kind === 'tool' || i.text.trim())
}

/** What a finished turn hides behind its "Worked for" line. */
export interface Fold {
  /** Ids of the blocks inside the fold; the rest show after it, in order. */
  hidden: Set<string>
  label: string
}

/**
 * The fold of a finished turn: everything but the answer (its last text) hides behind
 * "Worked for 54s". A background process and a delegation whose agents still run keep their
 * cards in view; so does a call after the answer that failed or still runs. A turn that failed
 * or was interrupted does not fold, and neither does one with nothing to hide.
 */
export function foldOf(turn: TurnEntry): Fold | undefined {
  if (turn.status !== 'done') {
    return undefined
  }

  const answer = turn.blocks.findLastIndex(b => b.kind === 'text' && b.text.trim())
  const hidden = new Set<string>()

  for (const [i, b] of turn.blocks.entries()) {
    // The answer stays, and so do the user's own words and the compactions: neither folds away.
    if (i === answer || b.kind === 'steer' || b.kind === 'compaction') {
      continue
    }

    // Cards that still want the user stay out of the fold: a background process, a wait on one,
    // running agents, apps to authorize, an image.
    if (
      b.kind === 'tool' &&
      (isBackgroundCall(b.call) ||
        waiting(b.call) ||
        isConnectCall(b.call) ||
        showsImage(b.call) ||
        b.call.subagents?.some(a => a.status === 'running' || a.status === 'queued'))
    ) {
      continue
    }

    if (answer >= 0 && i > answer && b.kind === 'tool' && b.call.status !== 'done') {
      continue
    }

    hidden.add(b.id)
  }

  if (hidden.size === 0) {
    return undefined
  }

  const ms = (turn.endedAt ?? turn.startedAt) - turn.startedAt

  return { hidden, label: workedFor(ms) }
}

const workedFor = (ms: number) => (ms > 0 ? `Worked for ${durationCompact(ms)}` : 'Worked')

/** A turn in reading order: folds ("Worked for 20s") and the blocks that stay in view. */
export type Part = { blocks: Block[]; key: string; kind: 'fold'; label: string } | { blocks: Block[]; kind: 'shown' }

/**
 * A turn as it reads once finished. Its steers and compactions split it, as a new prompt splits
 * t3code's runs: each stretch folds behind how long it took (from the split before it, or the
 * turn's start, to the one after it, or the end), what stays in view follows its fold, then the
 * split itself.
 * A turn that does not fold is one shown part.
 */
export function parts(turn: TurnEntry): Part[] {
  const fold = foldOf(turn)

  if (!fold) {
    return [{ blocks: [...turn.blocks], kind: 'shown' }]
  }

  const out: Part[] = []
  const show = (b: Block) => {
    const last = out.at(-1)

    if (last?.kind === 'shown') {
      last.blocks.push(b)
    } else {
      out.push({ blocks: [b], kind: 'shown' })
    }
  }

  let stretch: Block[] = []
  let from = turn.startedAt

  const flush = (to: number) => {
    const hidden = stretch.filter(b => fold.hidden.has(b.id))

    if (hidden.length) {
      out.push({ blocks: hidden, key: `fold${hidden[0]!.id}`, kind: 'fold', label: workedFor(to - from) })
    }

    stretch.filter(b => !fold.hidden.has(b.id)).forEach(show)
    stretch = []
  }

  for (const b of turn.blocks) {
    if (b.kind === 'steer' || b.kind === 'compaction') {
      flush(b.at)
      show(b)
      from = b.kind === 'compaction' ? (b.compaction.endedAt ?? b.at) : b.at
    } else {
      stretch.push(b)
    }
  }

  flush(turn.endedAt ?? from)

  return out
}

/** What a call counts as in a summary: its view's action (an app's while it acted in apps only); `other` when its view throws. */
export function actionOf(call: ToolCall): Action {
  return withView(call, view => view.action())
}

const and = (words: readonly string[]) => (words.length < 3 ? words.join(' and ') : `${words.slice(0, -1).join(', ')}, and ${words.at(-1)}`)

function actionLabel(action: Action, n: number, calls: readonly ToolCall[] = []): string {
  switch (action) {
    case 'app': {
      // "Used Linear 3 times", "Used Linear and Slack": the apps, as connectors are not interchangeable.
      const apps = [...new Set(calls.flatMap(appsOf))]
      const uses = calls.reduce((k, c) => k + (c.batch?.length ?? 1), 0)

      return apps.length === 1 ? `Used ${apps[0]}${uses > 1 ? ` ${uses} times` : ''}` : `Used ${and(apps)}`
    }

    case 'command':
      return `Ran ${plural(n, 'command')}`

    case 'read':
      return `Read ${plural(n, 'file')}`

    case 'edit':
      return `Changed ${plural(n, 'file')}`

    case 'code-search':
      return `Searched code ${plural(n, 'time')}`

    case 'search':
      return `Searched the web ${plural(n, 'time')}`

    case 'fetch':
      return `Read ${plural(n, 'page')}`

    case 'browser':
      return `Used browser ${plural(n, 'time')}`

    case 'lookup':
      return `Looked up tools${n > 1 ? ` ${n} times` : ''}`

    case 'plan':
      return `Updated the plan${n > 1 ? ` ${n} times` : ''}`

    case 'other':
      return `Used ${plural(n, 'tool')}`
  }
}

/** Changes and work in other apps outrank looking around, which outranks everything else. */
const priority = (a: Action) => (a === 'command' || a === 'edit' || a === 'app' ? 0 : a === 'other' || a === 'lookup' ? 2 : 1)

/**
 * t3code's `summarizeToolGroup`: calls counted by action, the two that matter most kept in
 * first-use order ("Ran 3 commands and read 2 files"), the rest as "performed N other
 * actions". Edits count files, not calls. Thoughts alone read "Thought" or "Thought (×3)".
 */
export function summarize(items: readonly WorkItem[]): string {
  const calls = items.flatMap(i => (i.kind === 'tool' ? [i.call] : []))

  if (!calls.length) {
    return items.length === 1 ? 'Thought' : `Thought (×${items.length})`
  }

  const groups = new Map<Action, ToolCall[]>()

  for (const c of calls) {
    const a = actionOf(c)
    groups.set(a, [...(groups.get(a) ?? []), c])
  }

  const all = [...groups].map(([action, list], index) => ({
    count: list.length,
    index,
    label: actionLabel(action, action === 'edit' ? editedFiles(list) : list.length, list),
    priority: priority(action)
  }))

  const picked = [...all]
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index)

  const labels = picked.map(p => p.label)
  const rest = calls.length - picked.reduce((n, p) => n + p.count, 0)

  if (rest > 0) {
    labels.push(`Performed ${plural(rest, 'other action')}`)
  }

  const words = labels.map((l, i) => (i === 0 ? l : l.charAt(0).toLowerCase() + l.slice(1)))

  return words.length < 3 ? words.join(' and ') : `${words.slice(0, -1).join(', ')}, and ${words.at(-1)}`
}

function editedFiles(calls: readonly ToolCall[]): number {
  const paths = new Set<string>()
  let unnamed = 0

  for (const c of calls) {
    const path = nonEmpty(c.args['path'])

    if (path) {
      paths.add(path)
    } else {
      unnamed++
    }
  }

  return paths.size + unnamed
}

/** A group's icon: what all its calls did, a brain for thoughts alone, a hammer for a mix. */
export function groupIcon(items: readonly WorkItem[]): string {
  const actions = new Set(items.flatMap(i => (i.kind === 'tool' ? [actionOf(i.call)] : [])))

  if (!actions.size) {
    return 'brain'
  }

  return actions.size === 1 ? actionIcon([...actions][0]!) : 'hammer'
}

/** A step's icon: its action's. */
export function actionIcon(action: Action): string {
  return ACTION_ICON[action]
}

/**
 * One step on one line, after t3code's `workEntryDisplayLabel`, in its view's words: a command
 * as its text (without an `sh -c` wrapper), a read as "Read path", a search as "Searched pattern
 * in folder"; the tool's name in words when its view throws.
 */
export function stepLabel(call: ToolCall): string {
  return withView(call, view => view.step())
}

/** The live line of a running group, after t3code's `liveWorkEntryLabel`: "Running ls". */
/**
 * The live group's line for its newest step. `active` (the turn is still at work on it) keeps a
 * step that already ended in the present tense, as t3code's `liveActivityToolStatus` does: the
 * agent is still busy, so "Running sed" stays until the next step or the answer replaces it.
 */
export function liveLabel(item: WorkItem, active = false): string {
  if (item.kind === 'thinking') {
    return thoughtTitle(item) || (item.endedAt === undefined || active ? 'Thinking' : 'Thought')
  }

  const call = item.call
  const status = active && call.status === 'done' ? 'running' : call.status
  const command = call.name === 'terminal' ? (nonEmpty(call.args['command']) ?? call.context) : undefined

  if (!command) {
    return status === 'running' ? presentTense(stepLabel(call)) : stepLabel(call)
  }

  const verb = { cancelled: 'Stopped', done: 'Ran', error: 'Failed', running: 'Running' }[status]

  return `${verb} ${commandProgramName(command) ?? 'command'}`
}

/** The working line for a call that just started: its live step ("Reading a.ts…", "Linear · create issue…"). */
export function busyLabel(call: ToolCall): string {
  return `${liveLabel({ call, id: call.id, kind: 'tool' }, true)}…`
}

/** The working line while the model writes a call: only its name is known yet. */
export function preparingLabel(name: string): string {
  const app = callApp({ args: {}, name })

  return `Preparing ${app ? `${app.app} · ${app.action}` : name.replace(/_/g, ' ')}…`
}

const PRESENT: Record<string, string> = {
  Edited: 'Editing',
  Linked: 'Linking',
  Listed: 'Listing',
  Looked: 'Looking',
  Read: 'Reading',
  Searched: 'Searching',
  Unlinked: 'Unlinking',
  Used: 'Using',
  Wrote: 'Writing'
}

/** `Read a.ts` → `Reading a.ts`: a step label's leading past-tense verb in the present tense. */
export function presentTense(label: string): string {
  const [verb = '', ...rest] = label.split(' ')

  return PRESENT[verb] ? [PRESENT[verb], ...rest].join(' ') : label
}

/** A thought on one line: its Markdown dropped, its whitespace collapsed. */
export function thoughtLine(markdown: string): string {
  return flat(
    markdown
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, '')
      .replace(/`+|\*\*|~~/g, '')
      .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, '$1$2')
  )
}

/** A thought's row: its line, after the label of one that is not the agent's own ("Reference 1/3 · gpt-5: …"). */
export function thoughtTitle(item: { label?: string; text: string }): string {
  const line = thoughtLine(item.text)

  return item.label ? (line ? `${item.label}: ${line}` : item.label) : line
}
