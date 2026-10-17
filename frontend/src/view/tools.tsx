// Tool calls as Tern `tool` nodes, in omp's vocabulary: Tern styles a tool by
// its `name` (bash, read, edit, write, grep, glob, web_search, todo, task, ask,
// eval pick the icon and the layout), so each hermes tool maps onto the omp
// tool it resembles, with the same props and body shapes omp sends.

import { type JSX, node } from '@stencil-hq/tern'

import { agentName } from '../agents/store.js'
import { callApp } from '../bridge.js'
import { CONNECT_TOOL, connectTargets, isConnectCall, waiting } from '../connections.js'
import type { Subagent, Todo, ToolCall } from '../model.js'
import { isRunning as processRuns, processElapsed, processIdOf, processTone, processVerdict, watchersOf } from '../processes/store.js'
import { isBackgroundCall, record } from '../transcript.js'
import { appsOf } from '../workLog.js'

import { commandLine, describeCommand } from './describe.js'
import { age, compact, duration } from './time.js'

/** How one call presents: omp's tool props (minus status and timing) and its body. */
interface Card {
  name: string
  title: string
  target?: string
  targetKind?: 'command' | 'path' | 'pattern' | 'query' | 'text'
  role?: string
  lang?: string
  meta?: string[]
  badges?: { text: string; tone?: string }[]
  /** `inline` drops the frame and keeps the head line (omp's read, grep, glob). */
  frame?: 'inline'
  /** Folded once settled. */
  folded?: boolean
  preview?: { lines: number } | { tail: number }
  /** Overrides the derived status (a task stays running while its agents work). */
  status?: 'running'
  /** Overrides the call's own duration (a background task lasts until its agents finish). */
  took?: number
  body: JSX.Element[]
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** Where a card shows: alone, or as one step of a folded run (one line until opened). */
export interface ToolPlace {
  inRun?: boolean
}

/** The `tool` node of one call. */
export function toolNode(call: ToolCall, now: number, place: ToolPlace = {}): JSX.Element {
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
      // A run's steps are one line each; the run's head says what is running.
      preview: place.inRun ? undefined : card.preview,
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
  const command = call.name === 'terminal' ? (str(call.args.command) ?? call.context ?? '').trim() : ''

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

function cardOf(call: ToolCall, now: number): Card {
  const result = record(call.result)
  const app = callApp(call)

  // A connector or MCP tool: the app it acted in heads the card, its arguments and answer below.
  if (app) {
    return {
      badges: [{ text: app.kind === 'mcp' ? 'MCP' : 'connector' }],
      body: call.batch ? batchBody(call) : appBody(call),
      folded: true,
      frame: 'inline',
      name: 'plug',
      target: app.action,
      targetKind: 'text',
      title: app.app
    }
  }

  if (call.batch) {
    const apps = appsOf(call)

    return {
      badges: apps.length ? [{ text: 'connectors' }] : undefined,
      body: batchBody(call),
      folded: true,
      frame: 'inline',
      name: 'plug',
      target: `${call.batch.length} calls`,
      targetKind: 'text',
      title: apps.length ? apps.join(', ') : 'Tool calls'
    }
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

    case 'todo_list':
      return {
        body: call.todos?.length ? [checklistNode(call.todos)] : [],
        name: 'todo',
        target: todoCount(call.todos),
        targetKind: 'text',
        title: 'Todo'
      }

    case 'delegate_task':
      return taskCard(call, result, now)

    case 'clarify':
      return askCard(call, result)

    case 'execute_code':
      return evalCard(call, result)

    case 'memory':
      return {
        body: [],
        frame: 'inline',
        meta: str(result?.usage) ? [`${result?.usage}`] : undefined,
        name: 'memory',
        target: call.context || str(call.args.action),
        targetKind: 'text',
        title: 'Memory'
      }
    case 'skills_list': {
      const skills = Array.isArray(result?.skills) ? result.skills : []
      const names = skills.map(s => str(record(s)?.name) ?? str(s)).filter(n => n !== undefined)

      return {
        body: names.length ? [<text key="names" spans={[{ s: 'muted', t: names.join(' · ') }]} wrap="word" />] : [],
        folded: true,
        frame: 'inline',
        meta: [
          names.length ? `${names.length} skill${names.length === 1 ? '' : 's'}` : (str(result?.message) ?? 'no skills')
        ],
        name: 'skill',
        title: 'Skills'
      }
    }

    case 'skill_view':
      return {
        body: str(result?.content) ? [<md key="body">{clip(str(result?.content) ?? '', 6000)}</md>] : [],
        folded: true,
        frame: 'inline',
        name: 'skill',
        target: str(call.args.name) ?? call.context,
        targetKind: 'text',
        title: 'Skill'
      }
  }

  const look = call.name.startsWith('browser')
    ? { name: 'browser', title: humanize(call.name.replace(/^browser_?/, '')) || 'Browser' }
    : call.name === 'session_search'
      ? { name: 'search', title: 'Session search' }
      : call.name === 'vision_analyze'
        ? { name: 'image', title: 'Vision' }
        : { name: call.name, title: humanize(call.name) }

  return {
    ...look,
    body: genericBody(call),
    folded: true,
    frame: 'inline',
    target: str(call.args.query) ?? str(call.args.url) ?? (call.context || undefined),
    targetKind: str(call.args.url) ? 'path' : str(call.args.query) ? 'query' : 'text'
  }
}

/** `instead`, when given, takes the output's place (a background call's process line). */
function bashCard(call: ToolCall, result: Record<string, unknown> | undefined, instead?: JSX.Element): Card {
  // The cancelled card's notice already says the command was interrupted.
  const output = (str(result?.output) ?? call.resultText)?.replace(/\s*\[Command interrupted\]\s*$/, '')
  const error = str(result?.error)
  const command = (str(call.args.command) ?? call.context ?? '').trim()
  const line = commandLine(command)
  const running = call.status === 'running'

  // The head says what the step is for and shows the command on one line, so it never grows
  // when the card opens; a command longer than that line opens into the body, above its output.
  return {
    body: [
      ...(command && command !== line
        ? [<code key="cmd" lang="bash" max={{ h: '12lines' }} role="omp.tool.command" text={command} />]
        : []),
      ...(instead ? [instead] : output ? [<ansi follow key="out" max={{ h: '20lines' }} text={output} />] : []),
      ...(error ? [<text key="err" role="omp.tool.error" spans={[{ s: 'error', t: error }]} wrap="word" />] : [])
    ],
    folded: true,
    lang: 'bash',
    name: 'bash',
    preview: { tail: running ? 4 : 3 },
    // A short command is the head's target; a longer one shows whole in the body instead.
    target: command === line ? line || undefined : undefined,
    targetKind: 'command',
    title: describeCommand(command)
  }
}

/**
 * A `terminal(background=true)` call: the bash card with a `background` badge and the watchers
 * Hermes armed, and, in place of the start notice, the process's live line from the store
 * (running · run time · last output line, then how it ended). A click on that line opens the
 * Background sheet on the process.
 */
function backgroundCard(call: ToolCall, result: Record<string, unknown> | undefined, now: number): Card {
  const w = watchersOf(call)
  const id = processIdOf(call) ?? call.process?.id
  const line = id ? processLine(call, id, now) : undefined
  // The start result ("Background process started") says nothing the process line does not.
  const card = bashCard(call, result, line)

  return {
    ...card,
    badges: [
      { text: 'background' },
      ...(w.notify ? [{ text: 'notify on exit' }] : []),
      ...w.patterns.map(p => ({ text: `watch: ${clip(p, 32)}` })),
      ...(w.heartbeat ? [{ text: `every ${w.heartbeat}s` }] : [])
    ],
    folded: line ? false : card.folded
  }
}

function processLine(call: ToolCall, id: string, now: number): JSX.Element {
  const p = call.process
  const live = !p || processRuns(p)
  const tone = p ? processTone(p.status) : 'muted'

  return (
    <row
      actions={{ click: `open-process=${id}`, menu: [`open-process=${id}`] }}
      align="center"
      gap="xs"
      key="process"
      role="omp.tool.process"
      title="Open in the Background sheet  ⌥B"
    >
      {p && live ? (
        <spinner key="state-icon" style="dots" tone="accent" />
      ) : (
        <icon key="state-icon" name={p ? (p.status === 'done' ? 'done' : p.status === 'failed' ? 'failed' : 'aborted') : 'pending'} tone={tone} />
      )}
      <text key="state" spans={[{ s: tone, t: p ? processVerdict(p) : 'starting' }]} wrap="none" />
      {p ? <text key="sep1" spans={[{ s: 'dim', t: '·' }]} wrap="none" /> : null}
      {p && live ? <elapsed age={age(p, p.startedAt, now)} format="short" key="time" /> : null}
      {p && !live ? <text key="took" spans={[{ s: 'muted', t: duration(processElapsed(p, now)) }]} wrap="none" /> : null}
      {p?.lastLine ? <text key="sep2" spans={[{ s: 'dim', t: '·' }]} wrap="none" /> : null}
      {p?.lastLine ? <text grow={1} key="last" spans={[{ s: 'muted mono', t: p.lastLine }]} truncate="end" wrap="none" /> : null}
    </row>
  )
}

/** One call in a few words, for a run's head: "Check git status", "Read README.md". */
export function stepTitle(call: ToolCall): string {
  if (call.name === 'terminal') {
    return describeCommand(str(call.args.command) ?? call.context ?? '')
  }

  const card = cardOf(call, Date.now())
  const target = card.target ? (card.targetKind === 'path' ? card.target.split('/').at(-1) : card.target) : undefined

  return target ? `${card.title} ${target}` : card.title
}

function readCard(call: ToolCall, result: Record<string, unknown> | undefined): Card {
  const path = str(call.args.path) ?? call.context
  const content = str(result?.content)
  const total = typeof result?.total_lines === 'number' ? result.total_lines : undefined
  const numbered = content ? [...content.matchAll(/^ *(\d+)\|/gm)] : []
  const first = numbered.length ? Number(numbered[0]?.[1]) : undefined
  const last = numbered.length ? Number(numbered.at(-1)?.[1]) : undefined
  const whole = first === 1 && last !== undefined && last === total
  const meta = first !== undefined && last !== undefined ? [whole ? `${total} lines` : `:${first}-${last}`] : []

  return {
    body: content
      ? [<code key="code" lang={langOf(path)} numbers start={first} text={content.replace(/^ *\d+\|/gm, '')} />]
      : [],
    folded: true,
    frame: 'inline',
    meta,
    name: 'read',
    target: path,
    targetKind: 'path',
    title: 'Read'
  }
}

function editCard(call: ToolCall, result: Record<string, unknown> | undefined): Card {
  const path = str(call.args.path) ?? call.context
  const lang = langOf(path)
  const diff = hunks(str(result?.diff)) ?? (call.diff ? plainDiff(call.diff) : undefined)
  const content = str(call.args.content)
  const write = call.name === 'write_file'

  const head = {
    name: write ? 'write' : 'edit',
    target: path,
    targetKind: 'path' as const,
    title: write ? 'Write' : 'Edit'
  }

  // A new file is all additions: omp shows it as the file, numbered, with a badge.
  if (write && content && (!diff || diff.startsWith('@@ -0,0 '))) {
    const text = content.replace(/\n$/, '')
    const lines = text.split('\n').length

    return {
      ...head,
      badges: diff ? [{ text: 'new file', tone: 'success' }] : undefined,
      body: [<code key="code" lang={lang ?? 'text'} numbers text={text} />],
      folded: true,
      meta: [`${lines} line${lines === 1 ? '' : 's'}`],
      preview: { lines: 8 }
    }
  }

  if (!diff) {
    return { ...head, body: [] }
  }

  const { added, removed } = diffStats(diff)

  return { ...head, body: [<diff key="diff" lang={lang} text={diff} />], meta: [`+${added} −${removed}`] }
}

function searchCard(call: ToolCall, result: Record<string, unknown> | undefined): Card {
  const pattern = str(call.args.pattern) ?? call.context
  const where = str(call.args.path)
  const inPath = where && where !== '.' ? ` · in ${where}` : ''
  const files = Array.isArray(result?.files) ? result.files.map(f => str(f)).filter(f => f !== undefined) : undefined

  if (files || call.args.target === 'files') {
    const list = (files ?? []).map(f => f.replace(/^\.\//, ''))
    const total = typeof result?.total_count === 'number' ? result.total_count : list.length

    return {
      body: list.slice(0, 200).map((f, i) => {
        const slash = f.lastIndexOf('/')

        return (
          <row key={`f${i}`} role="omp.tool.file" title={slash > 0 ? f.slice(0, slash + 1) : undefined}>
            <text key="p" spans={[{ s: 'path', t: slash > 0 ? f.slice(slash + 1) : f }]} />
          </row>
        )
      }),
      folded: list.length > 20,
      frame: 'inline',
      meta: files ? [`${total} file${total === 1 ? '' : 's'}${inPath}`] : undefined,
      name: 'glob',
      target: pattern,
      targetKind: 'pattern',
      title: 'Glob'
    }
  }

  const matches = Array.isArray(result?.matches)
    ? result.matches.map(m => record(m)).filter(m => m !== undefined)
    : undefined

  const byFile = new Map<string, { line: number; text: string }[]>()

  for (const m of matches ?? []) {
    const path = (str(m.path) ?? '').replace(/^\.\//, '')
    const list = byFile.get(path) ?? []
    list.push({ line: typeof m.line === 'number' ? m.line : 0, text: typeof m.content === 'string' ? m.content : '' })
    byFile.set(path, list)
  }

  const total = typeof result?.total_count === 'number' ? result.total_count : (matches?.length ?? 0)
  const body: JSX.Element[] = []
  let fileIndex = 0

  for (const [path, hits] of byFile) {
    const f = `f${fileIndex++}`
    body.push(
      <row key={f} role="omp.tool.file">
        <text key="p" spans={[{ s: 'path', t: path }]} />
        <text key="n" role="omp.tool.chip" spans={[{ t: String(hits.length) }]} />
      </row>
    )

    // Consecutive lines share one numbered block; gaps show omp's `…` row.
    let run: { line: number; text: string }[] = []
    let runIndex = 0

    const flush = () => {
      const start = run[0]?.line ?? 1

      if (runIndex > 0) {
        body.push(<text key={`${f}.g${runIndex}`} role="omp.tool.context" spans={[{ s: 'muted', t: '…' }]} />)
      }

      body.push(
        <code
          key={`${f}.c${runIndex++}`}
          lang={langOf(path)}
          marks={run.map(h => ({ line: h.line, tone: 'accent' }))}
          numbers
          start={start}
          text={run.map(h => h.text).join('\n')}
        />
      )
      run = []
    }

    for (const hit of hits) {
      if (run.length && hit.line !== (run.at(-1)?.line ?? 0) + 1) {
        flush()
      }

      run.push(hit)
    }

    if (run.length) {
      flush()
    }
  }

  return {
    body,
    folded: total > 40,
    frame: 'inline',
    meta: matches
      ? [`${total} match${total === 1 ? '' : 'es'} · ${byFile.size} file${byFile.size === 1 ? '' : 's'}${inPath}`]
      : undefined,
    name: 'grep',
    target: pattern,
    targetKind: 'pattern',
    title: 'Grep'
  }
}

function webSearchCard(call: ToolCall, result: Record<string, unknown> | undefined): Card {
  const data = record(result?.data)

  const hits = (Array.isArray(data?.web) ? data.web : Array.isArray(result?.results) ? result.results : [])
    .map(h => record(h))
    .filter(h => h !== undefined)

  return {
    body: hits.length
      ? [
          <col key="s" role="omp.tool.sources">
            {hits.map((h, i) => sourceRow(`s${i}`, str(h.title) ?? str(h.url) ?? '', str(h.url)))}
          </col>
        ]
      : [],
    frame: 'inline',
    meta: hits.length ? [`${hits.length} source${hits.length === 1 ? '' : 's'}`] : undefined,
    name: 'web_search',
    target: str(call.args.query) ?? call.context,
    targetKind: 'query',
    title: 'Web search'
  }
}

function fetchCard(call: ToolCall, result: Record<string, unknown> | undefined): Card {
  const pages = (Array.isArray(result?.results) ? result.results : []).map(p => record(p)).filter(p => p !== undefined)
  const urls = Array.isArray(call.args.urls) ? call.args.urls.map(u => str(u)).filter(u => u !== undefined) : []
  const body: JSX.Element[] = []

  for (const [i, p] of pages.entries()) {
    body.push(sourceRow(`s${i}`, str(p.title) ?? str(p.url) ?? '', str(p.url)))
    const content = str(p.content)

    if (content) {
      body.push(<md key={`b${i}`}>{clip(content, 4000)}</md>)
    }
  }

  const chars = pages.reduce((n, p) => n + (str(p.content)?.length ?? 0), 0)

  return {
    body,
    folded: true,
    meta: pages.length ? [`${pages.length} page${pages.length === 1 ? '' : 's'} · ${compact(chars)} chars`] : undefined,
    name: 'fetch',
    preview: { lines: 6 },
    target: urls.length > 1 ? `${urls[0]} +${urls.length - 1}` : (urls[0] ?? str(call.args.url) ?? call.context),
    targetKind: 'path',
    title: 'Fetch'
  }
}

/** One linked source: a domain-initial chip, the linked title, the muted domain. */
function sourceRow(key: string, title: string, url: string | undefined): JSX.Element {
  let host = ''

  try {
    host = url ? new URL(url).hostname.replace(/^www\./, '') : ''
  } catch {
    host = ''
  }

  return (
    <row key={key} role="omp.tool.source">
      <text key="d" role="omp.tool.chip" spans={[{ t: (host.charAt(0) || '·').toUpperCase() }]} />
      <text key="t" spans={[url ? { href: url, t: title } : { t: title }]} />
      {host ? <text key="m" spans={[{ s: 'muted', t: host }]} /> : null}
    </row>
  )
}

function taskCard(call: ToolCall, result: Record<string, unknown> | undefined, now: number): Card {
  const tasks = Array.isArray(call.args.tasks) ? call.args.tasks.map(t => record(t)).filter(t => t !== undefined) : []

  const goals = tasks.length
    ? tasks.map(t => str(t.goal) ?? '')
    : str(call.args.goal)
      ? [str(call.args.goal) ?? '']
      : []

  const agents = call.subagents ?? []

  // Until the first subagent event, the requested tasks stand in as pending rows.
  const rows = agents.length
    ? agents.map(a => agentNode(a, now))
    : call.status === 'running' || result?.status === 'dispatched'
      ? goals.map((g, i) => <agent agent="task" key={`p${i}`} name={`Agent ${i + 1}`} status="pending" task={g} />)
      : []

  const context = str(call.args.context) ?? (tasks.length === 1 ? str(tasks[0]?.context) : undefined)

  const working =
    agents.some(a => a.status === 'running' || a.status === 'queued') ||
    (!agents.length && result?.status === 'dispatched')

  const settled = agents.filter(a => a.status !== 'running' && a.status !== 'queued')
  const count = goals.length || agents.length
  let meta: string | undefined
  let took: number | undefined

  if (agents.length && !working) {
    const ok = agents.filter(a => a.status === 'done').length
    const stopped = agents.filter(a => a.status === 'cancelled').length
    const failed = agents.length - ok - stopped
    const requests = agents.reduce((n, a) => n + a.calls, 0)
    meta = [
      `${ok} succeeded`,
      failed ? `${failed} failed` : '',
      stopped ? `${stopped} stopped` : '',
      requests ? `${requests} req` : ''
    ]
      .filter(Boolean)
      .join(' · ')
    took = Math.max(...agents.map(a => a.startedAt + (a.duration ?? 0))) - call.startedAt
  } else if (settled.length) {
    meta = `${settled.length} of ${count} done`
  }

  return {
    badges: result?.mode === 'background' ? [{ text: 'background' }] : undefined,
    body: [
      ...(context
        ? [<text key="ctx" role="omp.tool.context" spans={[{ s: 'muted', t: `Context: ${context}` }]} wrap="word" />]
        : []),
      ...rows
    ],
    meta: meta ? [meta] : undefined,
    name: 'task',
    status: working ? 'running' : undefined,
    target: count ? `${count} agent${count === 1 ? '' : 's'}` : undefined,
    targetKind: 'text',
    title: 'Task',
    took
  }
}

/**
 * One subagent as a Tern `agent` row, as the Task card and the agents hub show it. Its timer
 * gets the true age each time: Tern starts an agent's timer over whenever `stats` changes (a new
 * tool count, a status), so an age fixed at the first send would run late. The row is only
 * rebuilt when something about the agent changed, so this sends no extra frames.
 */
export function agentNode(a: Subagent, now: number): JSX.Element {
  const status =
    a.status === 'done'
      ? 'done'
      : a.status === 'failed'
        ? 'failed'
        : a.status === 'cancelled'
          ? 'aborted'
          : a.status === 'queued'
            ? 'pending'
            : 'running'

  const running = a.status === 'running'

  return (
    <agent
      // A click (or the context menu) opens the agent beside the chat; App handles the action.
      actions={{ click: `open-agent=${a.id}`, menu: [`open-agent=${a.id}`] }}
      agent="task"
      badges={a.exitReason && a.status !== 'done' ? [{ text: a.exitReason.replace(/_/g, ' '), tone: 'warning' }] : undefined}
      collapsed={a.summary ? true : undefined}
      collapsible={a.summary ? true : undefined}
      depth={a.depth || undefined}
      key={a.key ?? a.id}
      model={a.model}
      name={agentName(a)}
      stats={{
        requests: a.calls || undefined,
        tokens: a.tokens || undefined,
        tools: a.toolCount || undefined,
        ...(running ? { age: Math.max(0, now - a.startedAt) } : { took: a.duration })
      }}
      status={status}
      task={a.goal}
      title={`Open ${agentName(a)} beside the chat`}
      tool={
        running && a.tool
          ? {
              age: a.toolSince ? age(a.toolSince, a.toolSince.at, now) : undefined,
              intent: a.toolPreview,
              name: a.tool
            }
          : undefined
      }
    >
      {a.summary ? <md key="o">{a.summary}</md> : null}
    </agent>
  )
}

function askCard(call: ToolCall, result: Record<string, unknown> | undefined): Card {
  const qs = (Array.isArray(call.args.questions) ? call.args.questions : str(call.args.question) ? [call.args] : [])
    .map(q => record(q))
    .filter(q => q !== undefined)

  const responses = Array.isArray(result?.responses) ? result.responses.map(r => record(r)) : []
  const body: JSX.Element[] = []

  for (const [i, q] of qs.entries()) {
    const choices = Array.isArray(q.choices) ? q.choices.map(c => str(c)).filter(c => c !== undefined) : []
    // A multi-select answer is a list of picks; a single answer a string.
    const raw = responses[i]?.user_response
    const answers = (Array.isArray(raw) ? raw : [raw]).map(a => str(a)).filter(a => a !== undefined)

    // One question already reads in the head; several each get their own.
    if (qs.length > 1) {
      body.push(<md key={`q${i}`}>{str(q.question) ?? ''}</md>)
    }

    for (const [j, c] of choices.entries()) {
      body.push(answerRow(`q${i}.o${j}`, c, answers.includes(c)))
    }

    for (const [j, typed] of answers.filter(a => !choices.includes(a)).entries()) {
      body.push(answerRow(`q${i}.a${j}`, typed, true))
    }

    if (!answers.length && call.status !== 'running') {
      body.push(<text key={`q${i}.none`} role="omp.tool.notice" spans={[{ s: 'muted', t: 'No answer' }]} />)
    }
  }

  return {
    body,
    name: 'ask',
    // Several questions each read in the body; the head counts them instead of repeating one.
    target: qs.length > 1 ? `${qs.length} questions` : (str(qs[0]?.question) ?? call.context),
    targetKind: 'text',
    title: 'Ask'
  }
}

function answerRow(key: string, text: string, picked: boolean): JSX.Element {
  return (
    <row key={key} role={picked ? 'omp.tool.answer' : 'omp.tool.answer.off'}>
      <text key="c" spans={[picked ? { s: 'success', t: '✓' } : { s: 'dim', t: '·' }]} />
      <text key="t" spans={[{ t: text }]} />
    </row>
  )
}

function evalCard(call: ToolCall, result: Record<string, unknown> | undefined): Card {
  const code = str(call.args.code) ?? ''
  const output = str(result?.output) ?? str(result?.stdout) ?? call.resultText
  const error = str(result?.error) ?? str(result?.stderr)

  return {
    badges: [{ text: 'python' }],
    body: [
      <col key="cell-0" role="omp.tool.eval.cell">
        <row align="start" key="input" role="omp.tool.eval.input">
          <icon aria="Input" key="0" name="arrow-left" role="omp.tool.eval.prompt" />
          <code key="code" lang="python" numbers={false} text={code} />
        </row>
        {output || error ? (
          <row align="start" key="result" role="omp.tool.eval.result">
            <icon aria="Output" key="0" name="arrow-right" role="omp.tool.eval.prompt" />
            <col key="outputs" role="omp.tool.eval.outputs">
              {output ? (
                <ansi follow={false} key="out" role="omp.tool.eval.output" text={output.replace(/\n$/, '')} />
              ) : null}
              {error ? <text key="err" role="omp.tool.error" spans={[{ s: 'error', t: error }]} wrap="word" /> : null}
            </col>
          </row>
        ) : null}
      </col>
    ],
    folded: false,
    name: 'eval',
    role: 'omp.tool.eval',
    title: firstLine(code)?.startsWith('#') ? (firstLine(code)?.replace(/^#+\s*/, '') ?? 'Eval') : 'Eval'
  }
}

const CONNECT_STATE: Record<string, { icon: string; tone?: 'error' | 'muted' | 'pending' | 'success'; word: string }> = {
  connected: { icon: 'check', tone: 'success', word: 'connected' },
  expired: { icon: 'clock', tone: 'error', word: 'link expired' },
  failed: { icon: 'x', tone: 'error', word: 'failed' },
  initiated: { icon: 'clock', tone: 'pending', word: 'waiting for you' },
  not_connected: { icon: 'minus', tone: 'muted', word: 'not connected' },
  pending: { icon: 'clock', tone: 'pending', word: 'waiting for you' },
  skipped: { icon: 'minus', tone: 'muted', word: 'skipped' }
}

/**
 * The connect card `manage_connections` gets on the desktop, for its no-card result: one row per
 * app with its state and an Authorize button that opens its link, then Continue, which tells the
 * agent the user is done (the tool's own note asks it to wait for that, then check status).
 */
function connectCard(call: ToolCall): Card {
  const targets = call.connect ?? connectTargets(call)
  const open = targets.filter(waiting)
  const rows = targets.map((t, i) => {
    const look = CONNECT_STATE[t.state] ?? CONNECT_STATE.pending!

    return (
      <row align="center" gap="sm" key={`t${i}`} role="hermes.connect.row">
        <icon key="i" name={look.icon} tone={look.tone} />
        <text
          grow={1}
          key="n"
          spans={[
            { s: 'strong', t: t.title },
            ...(t.alias ? [{ s: 'muted', t: ` (${t.alias})` }] : []),
            { s: look.tone ?? 'muted', t: `  ${look.word}` },
            ...(t.detail && look.tone === 'error' ? [{ s: 'muted', t: ` · ${t.detail}` }] : [])
          ]}
          truncate="end"
          wrap="none"
        />
        {t.url && waiting(t) ? (
          <row actions={{ click: `open-url=${t.url}` }} align="center" gap="xs" key="go" role="hermes.connect.open" title={t.url}>
            <text key="t" text="Authorize ↗" />
          </row>
        ) : null}
      </row>
    )
  })

  return {
    body: [
      ...rows,
      ...(call.connectDone
        ? [<text key="done" spans={[{ s: 'muted', t: 'Sent to Hermes.' }]} />]
        : [
            <row align="center" gap="sm" key="foot">
              <text
                grow={1}
                key="hint"
                spans={[{ s: 'muted', t: open.length ? 'Authorize in the browser, then continue.' : 'All set.' }]}
                wrap="word"
              />
              <row actions={{ click: `connect-continue=${call.id}` }} align="center" key="go" role="hermes.connect.continue">
                <text key="t" text="Done, continue" />
              </row>
            </row>
          ])
    ],
    name: 'plug',
    status: open.length && !call.connectDone ? 'running' : undefined,
    target: targets.map(t => t.title).join(', '),
    targetKind: 'text',
    title: open.length ? 'Connect apps' : 'Apps connected'
  }
}

/** A connector call: what it was asked (as facts), then what it answered. */
function appBody(call: ToolCall): JSX.Element[] {
  const facts = Object.entries(call.args)
    .filter(([k, v]) => k !== 'connector_alias' && v !== undefined && v !== null && v !== '')
    .slice(0, 12)
    .map(([k, v]) => ({ k: [{ t: k.replace(/_/g, ' ') }], v: clip(typeof v === 'string' ? v : JSON.stringify(v), 300) }))

  const error = call.status === 'error' ? errorOf(call) : undefined

  return [
    ...(facts.length ? [<kv items={facts} key="args" />] : []),
    ...(error ? [<text key="error" spans={[{ s: 'error', t: clip(error, 1200) }]} wrap="word" />] : genericBody(call))
  ]
}

/** A batch: one line per entry with its outcome, then each answer. */
function batchBody(call: ToolCall): JSX.Element[] {
  return (call.batch ?? []).flatMap((e, i) => {
    const app = callApp({ args: e.args, name: e.name })
    const tone = e.status === 'error' ? 'error' : e.status === 'running' ? 'pending' : 'success'
    const answer = e.error ?? (e.result === undefined ? undefined : pretty(e.result))

    return [
      <row align="center" gap="sm" key={`e${i}`}>
        <icon key="i" name={e.status === 'error' ? 'x' : e.status === 'running' ? 'clock' : 'check'} tone={tone} />
        <text grow={1} key="t" spans={[{ t: app ? `${app.app} · ${app.action}` : humanize(e.name) }]} truncate="end" wrap="none" />
      </row>,
      ...(e.error
        ? [<text key={`r${i}`} spans={[{ s: 'error', t: clip(e.error, 600) }]} wrap="word" />]
        : answer && call.status !== 'running'
          ? [<code key={`r${i}`} lang={/^\s*[[{]/.test(answer) ? 'json' : 'text'} max={{ h: '8lines' }} text={clip(answer, 2000)} wrap />]
          : [])
    ]
  })
}

function genericBody(call: ToolCall): JSX.Element[] {
  const text = call.resultText ?? (call.result === undefined ? undefined : pretty(call.result))

  if (!text || call.status === 'running') {
    return []
  }

  return [<code key="out" lang={/^\s*[[{]/.test(text) ? 'json' : 'text'} text={clip(text, 4000)} />]
}

function errorOf(call: ToolCall): string | undefined {
  const result = record(call.result)

  return (
    str(result?.error) ?? str(call.summary) ?? (typeof call.result === 'string' && !result ? call.result : undefined)
  )
}

function exitOf(call: ToolCall): number | undefined {
  const code = record(call.result)?.exit_code

  return typeof code === 'number' ? code : undefined
}

export function checklistNode(todos: Todo[]): JSX.Element {
  const status = (t: Todo) =>
    t.status === 'completed'
      ? 'done'
      : t.status === 'in_progress'
        ? 'active'
        : t.status === 'cancelled'
          ? 'dropped'
          : 'pending'

  const item = (t: Todo) => ({ id: t.id, status: status(t), text: t.content })
  const roots = todos.filter(t => !t.parent)
  const nested = todos.some(t => t.parent)

  // Subtasks group under their parent as omp's titled phases; a flat list is one untitled phase.
  const phases = nested
    ? roots.map(r => {
        const kids = todos.filter(t => t.parent === r.id)

        return {
          collapsed: kids.length > 0 && kids.every(k => k.status === 'completed'),
          id: r.id,
          items: kids.length ? kids.map(item) : [item(r)],
          title: r.content
        }
      })
    : [{ id: 'all', items: roots.map(item) }]

  return <checklist key="list" mode="full" phases={phases} />
}

/** The unified diff in hermes's colored `inline_diff`, without ANSI and the review header. */
export function plainDiff(raw: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  return hunks(raw.replace(/\x1b\[[0-9;]*m/g, ''))
}

/** A unified diff from its first hunk on (file headers dropped). */
function hunks(diff: string | undefined): string | undefined {
  const lines = diff?.split('\n') ?? []
  const start = lines.findIndex(l => l.startsWith('@@'))

  return start < 0 ? undefined : lines.slice(start).join('\n').trimEnd()
}

function diffStats(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0

  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added++
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed++
    }
  }

  return { added, removed }
}

const LANGS: Record<string, string> = {
  c: 'c',
  cpp: 'cpp',
  css: 'css',
  go: 'go',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  yaml: 'yaml',
  yml: 'yaml'
}

function langOf(path: string | undefined): string | undefined {
  const ext = path?.split('.').pop()?.toLowerCase()

  return ext ? LANGS[ext] : undefined
}

function todoCount(todos: Todo[] | undefined): string | undefined {
  if (!todos?.length) {
    return undefined
  }

  return `${todos.filter(t => t.status === 'completed').length}/${todos.length}`
}

function firstLine(text: string | undefined): string | undefined {
  return text
    ?.split('\n')
    .find(l => l.trim())
    ?.trim()
}

function humanize(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim()

  return words.charAt(0).toUpperCase() + words.slice(1)
}

function pretty(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text
}
