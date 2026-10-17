// A turn's work the way t3code's timeline shows it (apps/web/src/components/chat/
// MessagesTimeline.logic.ts and packages/client-runtime/src/work-log/presentation.ts):
// consecutive tool calls and thoughts form one work group with a summary ("Ran 3 commands
// and read 2 files"), each step one line; a finished turn folds everything but its answer
// behind "Worked for 54s". The views in view/workLog.tsx draw what this derives.

import { homedir } from 'node:os'

import { callApp } from './bridge.js'
import { isConnectCall } from './connections.js'
import type { Block, ToolCall, TurnEntry } from './model.js'
import { isBackgroundCall } from './transcript.js'
import { commandDisplayText, commandProgramName } from './vendor/t3code/commandLabel.js'

/** A step of a work group: a tool call or a thought. */
export type WorkItem = Extract<Block, { kind: 'thinking' | 'tool' }>

/** A turn in reading order: blocks that show alone, and groups of work between them. */
export type Piece = { kind: 'block'; block: Block } | { kind: 'work'; items: WorkItem[] }

/** Calls with a view of their own: a delegation's Task card, the todo list, clarify's questions. */
const SOLO = new Set(['clarify', 'delegate_task', 'todo', 'todo_list'])

/** A call that keeps its card: a solo tool, or a background process with its live line. */
export function ownsCard(call: ToolCall): boolean {
  return SOLO.has(call.name) || isBackgroundCall(call) || isConnectCall(call)
}

/** Splits blocks into text, steers and card-owning calls, and the work groups between them. */
export function pieces(blocks: readonly Block[]): Piece[] {
  const out: Piece[] = []
  let items: WorkItem[] = []

  for (const b of blocks) {
    if (b.kind === 'thinking' || (b.kind === 'tool' && !ownsCard(b.call))) {
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
    // The answer stays, and so do the user's own words: a steer is never folded away.
    if (i === answer || b.kind === 'steer') {
      continue
    }

    // Cards that still want the user stay out of the fold: a background process, running agents,
    // apps to authorize.
    if (
      b.kind === 'tool' &&
      (isBackgroundCall(b.call) || isConnectCall(b.call) || b.call.subagents?.some(a => a.status === 'running' || a.status === 'queued'))
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

const workedFor = (ms: number) => (ms > 0 ? `Worked for ${formatDuration(ms)}` : 'Worked')

/** A turn in reading order: folds ("Worked for 20s") and the blocks that stay in view. */
export type Part = { blocks: Block[]; key: string; kind: 'fold'; label: string } | { blocks: Block[]; kind: 'shown' }

/**
 * A turn as it reads once finished. Its steers split it, as a new prompt splits t3code's runs:
 * each stretch folds behind how long it took (from the steer before it, or the turn's start, to
 * the steer after it, or the end), what stays in view follows its fold, then the steer itself.
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
    if (b.kind === 'steer') {
      flush(b.at)
      show(b)
      from = b.at
    } else {
      stretch.push(b)
    }
  }

  flush(turn.endedAt ?? from)

  return out
}

/** t3code's `formatDuration` (packages/shared/src/orchestrationTiming.ts): 820ms, 4.3s, 42s, 1m 2s. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '0ms'
  }

  if (ms < 1_000) {
    return `${Math.max(1, Math.round(ms))}ms`
  }

  if (ms < 10_000) {
    const tenths = Math.round(ms / 100) / 10

    return tenths >= 10 ? '10s' : `${tenths.toFixed(1)}s`
  }

  if (ms < 60_000) {
    return `${Math.round(ms / 1_000)}s`
  }

  const total = Math.round(ms / 1_000)
  const h = Math.floor(total / 3_600)
  const m = Math.floor((total % 3_600) / 60)
  const s = total % 60

  return [h ? `${h}h` : '', m ? `${m}m` : '', s ? `${s}s` : ''].filter(Boolean).join(' ')
}

/** What a call counts as in a summary, after t3code's `toolGroupAction`. */
export type Action = 'app' | 'browser' | 'code-search' | 'command' | 'edit' | 'fetch' | 'lookup' | 'other' | 'read' | 'search'

export function actionOf(call: ToolCall): Action {
  // A connector or MCP tool acts in an app, whatever its name says; so does a batch of them.
  if (appsOf(call).length) {
    return 'app'
  }

  switch (call.name) {
    case 'tool_search':

    case 'tool_describe':
      return 'lookup'

    case 'terminal':

    case 'execute_code':

    case 'process':
      return 'command'

    case 'read_file':
      return 'read'

    case 'patch':

    case 'write_file':
      return 'edit'

    case 'search_files':
      return 'code-search'

    case 'web_search':
      return 'search'

    case 'web_extract':
      return 'fetch'
  }

  return call.name.startsWith('browser') ? 'browser' : 'other'
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
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
      return `Ran ${plural(n, 'command', 'commands')}`

    case 'read':
      return `Read ${plural(n, 'file', 'files')}`

    case 'edit':
      return `Changed ${plural(n, 'file', 'files')}`

    case 'code-search':
      return `Searched code ${plural(n, 'time', 'times')}`

    case 'search':
      return `Searched the web ${plural(n, 'time', 'times')}`

    case 'fetch':
      return `Read ${plural(n, 'page', 'pages')}`

    case 'browser':
      return `Used browser ${plural(n, 'time', 'times')}`

    case 'lookup':
      return `Looked up tools${n > 1 ? ` ${n} times` : ''}`

    case 'other':
      return `Used ${plural(n, 'tool', 'tools')}`
  }
}

/** The apps a call acted in: a connector's, or each of a batch's (none when any entry is local). */
export function appsOf(call: ToolCall): string[] {
  const apps = (call.batch ?? [call]).map(e => callApp({ args: e.args, name: e.name })?.app)

  return apps.every(Boolean) ? [...new Set(apps as string[])] : []
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
    labels.push(`Performed ${plural(rest, 'other action', 'other actions')}`)
  }

  const words = labels.map((l, i) => (i === 0 ? l : l.charAt(0).toLowerCase() + l.slice(1)))

  return words.length < 3 ? words.join(' and ') : `${words.slice(0, -1).join(', ')}, and ${words.at(-1)}`
}

function editedFiles(calls: readonly ToolCall[]): number {
  const paths = new Set<string>()
  let unnamed = 0

  for (const c of calls) {
    const path = str(c.args.path)

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

export function actionIcon(action: Action): string {
  switch (action) {
    case 'app':
      return 'plug'

    case 'lookup':
      return 'search'

    case 'command':
      return 'terminal'

    case 'read':
      return 'eye'

    case 'edit':
      return 'pencil'

    case 'code-search':
      return 'search'

    case 'search':

    case 'fetch':
      return 'globe'

    case 'browser':
      return 'compass'

    case 'other':
      return 'wrench'
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** A path as the user reads it: under the working folder relative, under home with `~`. */
export function shortPath(path: string, cwd = process.env.HERMES_CWD || process.cwd()): string {
  const root = cwd.replace(/\/+$/, '')

  if (root && path.startsWith(`${root}/`)) {
    return path.slice(root.length + 1)
  }

  const home = homedir()

  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path.replace(/^\.\//, '')
}

/**
 * One step on one line, after t3code's `workEntryDisplayLabel`: a command as its text (without
 * an `sh -c` wrapper), a read as "Read path", a search as "Searched pattern in folder".
 */
export function stepLabel(call: ToolCall): string {
  const a = call.args
  const path = str(a.path)
  const app = callApp(call)

  if (app) {
    return `${app.app} · ${app.action}`
  }

  if (call.batch) {
    return call.batch.map(e => stepLabel({ ...call, args: e.args, batch: undefined, name: e.name })).join(', ')
  }

  switch (call.name) {
    case 'terminal': {
      const command = str(a.command) ?? call.context

      return command ? flat(commandDisplayText(command)) : 'Command'
    }

    case 'read_file':
      return path ? `Read ${shortPath(path)}` : 'Read file'

    case 'patch':
      return path ? `Edited ${shortPath(path)}` : 'Edited a file'

    case 'write_file':
      return path ? `Wrote ${shortPath(path)}` : 'Wrote a file'

    case 'search_files': {
      const pattern = str(a.pattern) ?? call.context
      const where = path && path !== '.' ? ` in ${shortPath(path)}` : ''

      return a.target === 'files' ? `Searched files ${pattern}${where}` : `Searched ${pattern}${where}`
    }

    case 'web_search':
      return str(a.query) ? `Searched the web for ${a.query}` : 'Web search'

    case 'web_extract': {
      const urls = Array.isArray(a.urls) ? a.urls.filter(u => typeof u === 'string') : []
      const first = urls[0] ?? str(a.url)

      return first ? `Read ${first}${urls.length > 1 ? ` +${urls.length - 1} more` : ''}` : 'Read a page'
    }

    case 'execute_code':
      return call.context ? flat(call.context) : 'Ran a script'

    case 'link_pull_request':

    case 'unlink_pull_request': {
      const verb = call.name === 'link_pull_request' ? 'Linked' : 'Unlinked'
      const pr = str(a.url)?.match(/github[^/]*\/([^/]+\/[^/]+)\/pull\/(\d+)/)
      const repo = pr?.[1] ?? str(a.repository)
      const number = pr?.[2] ?? (typeof a.number === 'number' ? String(a.number) : undefined)

      return repo && number ? `${verb} ${repo}#${number}` : `${verb} a pull request`
    }

    case 'list_pull_requests':
      return 'Listed linked pull requests'

    case 'skill_view':
      return str(a.name) ? `Read skill ${a.name}` : 'Read a skill'

    case 'skills_list':
      return 'Listed skills'

    case 'tool_search': {
      const q = Array.isArray(a.queries) ? a.queries.filter(x => typeof x === 'string') : [str(a.queries) ?? str(a.query)].filter(Boolean)

      return q.length ? `Searched tools for ${q.join(', ')}` : 'Searched tools'
    }

    case 'tool_describe': {
      const names = (Array.isArray(a.names) ? a.names : [a.names]).filter((x): x is string => typeof x === 'string' && x !== '')

      // Connector names read as their app and action, as the calls themselves do.
      const named = names.map(n => {
        const app = callApp({ args: {}, name: n })

        return app ? `${app.app} · ${app.action}` : n.replace(/_/g, ' ')
      })

      return named.length ? `Read how to call ${named.join(', ')}` : 'Read tool details'
    }
  }

  const name = call.name.replace(/_/g, ' ')
  const label = name.charAt(0).toUpperCase() + name.slice(1)

  return call.context ? `${label}: ${flat(call.context)}` : label
}

/** The live line of a running group, after t3code's `liveWorkEntryLabel`: "Running ls". */
/**
 * The live group's line for its newest step. `active` (the turn is still at work on it) keeps a
 * step that already ended in the present tense, as t3code's `liveActivityToolStatus` does: the
 * agent is still busy, so "Running sed" stays until the next step or the answer replaces it.
 */
export function liveLabel(item: WorkItem, active = false): string {
  if (item.kind === 'thinking') {
    return thoughtLine(item.text) || (item.endedAt === undefined || active ? 'Thinking' : 'Thought')
  }

  const call = item.call
  const status = active && call.status === 'done' ? 'running' : call.status
  const command = call.name === 'terminal' ? (str(call.args.command) ?? call.context) : undefined

  if (!command) {
    return status === 'running' ? presentTense(stepLabel(call)) : stepLabel(call)
  }

  const verb = { cancelled: 'Stopped', done: 'Ran', error: 'Failed', running: 'Running' }[status]

  return `${verb} ${commandProgramName(command) ?? 'command'}`
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

const flat = (text: string) => text.replace(/\s+/g, ' ').trim()

/** `6:15 pm`: when a group started, for its hover line. */
export function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase()
}
