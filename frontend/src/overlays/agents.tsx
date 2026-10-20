// The agents hub (`/agents`, ⌥A, the agents pill): every subagent of the session in one
// `picker` sheet, as omp's hub draws them (a tree when orchestrators spawned workers, status
// dots, tool counts and timers), the selected one previewed as its live `agent` row, facts and
// latest activity. Enter opens the agent beside the chat (watch/: its full transcript, live,
// with a composer that steers it). T opens its timeline in this sheet instead (its live
// transcript log, one row per step, following the newest). S steers a running agent (the
// search line becomes the message), X stops it. P pauses (or resumes) new spawns, gateway-wide.

import type { JSX, Key, PickerColumn, PickerItem, Tone } from '@stencil-hq/tern'

import type { App } from '../app.js'
import { errorText } from '../core/errors.js'
import type { Subagent } from '../model.js'
import type { Overlay } from '../overlay.js'

import type { LogEntry } from '../agents/liveLog.js'
import { agentName, isRunning } from '../agents/store.js'
import { duration } from '../view/time.js'
import { agentNode, briefOf } from '../view/tools.js'

import { editQuery, moveSelection } from './search.js'

const KEY = 'agents'
/** Timers and the timeline follow the clock while the sheet is open. */
const TICK_MS = 1000
const RECENT = 6

type Tab = 'running' | 'all'

const DOT: Record<Subagent['status'], Tone> = {
  cancelled: 'warning',
  done: 'success',
  failed: 'error',
  queued: 'muted',
  running: 'accent'
}

const STATUS: Record<Subagent['status'], string> = {
  cancelled: 'Stopped',
  done: 'Done',
  failed: 'Failed',
  queued: 'Queued',
  running: 'Running'
}

/** Icons for the tools hermes children run most; the rest get a wrench. */
const TOOL_ICON: Record<string, string> = {
  browser_navigate: 'web',
  execute_code: 'python',
  patch: 'edit',
  read_file: 'read',
  search_files: 'search',
  terminal: 'bash',
  web_extract: 'web',
  web_search: 'web',
  write_file: 'write'
}

/** Opens the hub, on agent `focus` when given (its timeline when `watch`). */
export function openAgents(app: App, focus?: { id: string; watch?: boolean }) {
  const agents = () => app.agents.all()
  let tab: Tab = app.agents.running().length ? 'running' : 'all'
  let selected = focus?.id ?? agents().find(isRunning)?.id ?? agents()[0]?.id
  /** The agent whose timeline is open, if any. */
  let watching: string | undefined
  /** The selected timeline step; undefined follows the newest. */
  let step: string | undefined
  /** The steering message being typed, if any. */
  let steer: string | undefined
  let stopping = false

  // Ends with the sheet, however it closed (Esc, a session switch replacing the overlays).
  const timer = setInterval(() => (app.overlays.includes(overlay) ? app.changed() : clearInterval(timer)), TICK_MS)

  const close = () => {
    clearInterval(timer)
    app.close(overlay)
  }

  const current = () => agents().find(a => a.id === (watching ?? selected))

  const watch = (id: string | undefined) => {
    const a = agents().find(x => x.id === id)

    if (!a) {
      return
    }

    watching = a.id
    step = undefined
    void app.agents.refresh(a)
  }

  /** Opens the agent in a split beside the chat and closes the hub; its timeline here when no split can open. */
  const beside = (id: string | undefined) => {
    if (id) {
      close()
      void app.openAgent(id)
    }
  }

  const sendSteer = async () => {
    const a = current()
    const text = steer?.trim()
    steer = undefined

    if (!a || !text) {
      return app.changed()
    }

    try {
      const queued = await app.agents.steer(a, text)
      app.transcript.notice(
        queued ? `Steering queued for ${agentName(a)}.` : `${agentName(a)} is not taking steering now.`,
        queued ? 'info' : 'warning'
      )
    } catch (error) {
      app.transcript.notice(errorText(error), 'error')
    }

    app.changed()
  }

  const stop = async () => {
    const a = current()
    stopping = false

    if (!a || !isRunning(a)) {
      return app.changed()
    }

    try {
      if (!(await app.agents.stop(a))) {
        app.transcript.notice(`${agentName(a)} already finished.`, 'warning')
      }
    } catch (error) {
      app.transcript.notice(errorText(error), 'error')
    }

    app.changed()
  }

  /** Blocks or unblocks new spawns (`delegation.pause`, every chat on the gateway); running agents keep going. */
  const togglePause = async () => {
    try {
      const paused = await app.agents.pause(!app.agents.paused)
      app.transcript.notice(paused ? 'Subagent spawning paused for every chat on this gateway.' : 'Subagent spawning resumed.')
    } catch (error) {
      app.transcript.notice(errorText(error), 'error')
    }

    app.changed()
  }

  const shown = (): Subagent[] => (tab === 'running' ? agents().filter(isRunning) : agents())

  const steps = (a: Subagent): LogEntry[] => a.log?.entries ?? []

  const overlay: Overlay = {
    key: KEY,
    modal: true,
    cancel: close,
    node: () => {
      const now = Date.now()
      const watched = watching ? agents().find(a => a.id === watching) : undefined

      return watched ? timelineNode(watched, now) : hubNode(now)
    },
    onKey: (k: Key) => {
      const a = current()

      if (steer !== undefined) {
        if (k.name === 'escape') {
          steer = undefined
        } else if (k.name === 'enter') {
          void sendSteer()
        } else {
          steer = editQuery(k, steer) ?? steer
        }

        return true
      }

      if (stopping) {
        if (k.name === 'enter' || k.name === 'y') {
          void stop()
        } else if (k.name === 'escape' || k.name === 'n') {
          stopping = false
        }

        return true
      }

      if (k.name === 'escape') {
        if (watching) {
          selected = watching
          watching = undefined
        } else {
          close()
        }
      } else if (k.name === 's' && !k.ctrl && !k.alt && a && isRunning(a)) {
        steer = ''
      } else if (k.name === 'x' && !k.ctrl && !k.alt && a && isRunning(a)) {
        stopping = true
      } else if (watching && a) {
        const ids = steps(a).map((_, i) => `e${i}`)
        const moved = moveSelection(k, ids, step ?? ids.at(-1))

        if (moved !== undefined) {
          // Back on the newest step: follow again.
          step = moved === ids.at(-1) ? undefined : moved
        }
      } else if (k.name === 'enter') {
        beside(selected)
      } else if (k.name === 't' && !k.ctrl && !k.alt) {
        watch(selected)
      } else if (k.name === 'p' && !k.ctrl && !k.alt) {
        void togglePause()
      } else if (k.name === 'tab') {
        tab = tab === 'running' ? 'all' : 'running'
      } else {
        selected = moveSelection(
          k,
          shown().map(x => x.id),
          selected
        ) ?? selected
      }

      return true
    }
  }

  const steerProps = (a: Subagent | undefined) =>
    steer !== undefined && a
      ? { placeholder: `Steer ${agentName(a)}: type, then Enter (Esc cancels)`, query: steer }
      : {}

  const actions = (a: Subagent | undefined, inTimeline: boolean) => {
    const running = Boolean(a && isRunning(a))

    if (steer !== undefined) {
      return [
        { end: true, id: 'steer-cancel', keys: ['esc'], label: 'Cancel' },
        { id: 'steer-send', keys: ['enter'], label: 'Send', primary: true }
      ]
    }

    return [
      ...(inTimeline
        ? []
        : [
            { id: 'watch', keys: ['t'], label: 'Timeline' },
            { id: 'beside', keys: ['enter'], label: 'Open beside', primary: true },
            { id: 'pause', keys: ['p'], label: app.agents.paused ? 'Resume spawns' : 'Pause spawns' }
          ]),
      {
        disabled: running ? (a?.steerable === false ? ('Not taking steering now' as const) : undefined) : ('Finished' as const),
        id: 'steer',
        keys: ['s'],
        label: 'Steer'
      },
      { danger: true, disabled: running ? undefined : ('Finished' as const), id: 'stop', keys: ['x'], label: 'Stop' },
      { end: true, id: 'close', keys: ['esc'], label: inTimeline ? 'Back' : 'Close' }
    ]
  }

  const handlers = {
    cancel: () => {
      stopping = false
      app.changed()
    },
    close: () => {
      if (watching) {
        selected = watching
        watching = undefined
        app.changed()
      } else {
        close()
      }
    },
    confirm: () => void stop(),
    pause: () => void togglePause(),
    steer: () => {
      steer = ''
      app.changed()
    },
    'steer-cancel': () => {
      steer = undefined
      app.changed()
    },
    'steer-send': () => void sendSteer(),
    stop: () => {
      stopping = true
      app.changed()
    },
    tab: (ev: { value?: string }) => {
      tab = ev.value === 'running' ? 'running' : 'all'
      app.changed()
    },
    beside: () => beside(selected),
    watch: () => {
      watch(selected)
      app.changed()
    }
  }

  function hubNode(now: number): JSX.Element {
    const all = agents()
    const list = shown()
    const running = all.filter(isRunning).length

    if (!list.some(a => a.id === selected)) {
      selected = list[0]?.id
    }

    const a = list.find(x => x.id === selected)
    const columns: PickerColumn[] = [
      { format: 'num', head: 'Tools', id: 'tools', priority: 3 },
      { format: 'elapsed', head: 'Time', id: 'time', priority: 5 }
    ]

    return (
      <picker
        actions={actions(a, false)}
        columns={columns}
        confirm={stopping && a ? { act: 'confirm', label: 'Stop', text: `Stop ${agentName(a)}? Its partial work returns to Hermes.` } : undefined}
        empty={tab === 'running' ? 'No agents running. Tab shows finished ones.' : 'No subagents in this session yet'}
        icon="agents"
        items={all.map(x => hubItem(x, now))}
        key={KEY}
        layout={all.some(x => x.depth) ? 'tree' : 'rows'}
        noun="agents"
        onAction={handlers}
        onActivate={ev => beside(ev.item)}
        onSelect={ev => {
          selected = ev.item
          stopping = false
          app.changed()
        }}
        order={list.map(x => x.id)}
        preview="side"
        selected={selected}
        size="lg"
        subtitle={[
          { s: 'muted', t: summary(all) },
          ...(app.agents.paused ? [{ s: 'warning', t: ' · spawns paused (gateway-wide)' }] : [])
        ]}
        tab={tab}
        tabs={[
          { count: running, id: 'running', label: 'Running' },
          { count: all.length, id: 'all', label: 'All' }
        ]}
        title="Agents"
        total={all.length}
        {...steerProps(a)}
      >
        {a ? hubPreview(a, now, briefFor(app, a)) : null}
      </picker>
    )
  }

  function timelineNode(a: Subagent, now: number): JSX.Element {
    const entries = steps(a)
    const ids = entries.map((_, i) => `e${i}`)
    const sel = step && ids.includes(step) ? step : ids.at(-1)
    const at = sel ? ids.indexOf(sel) : -1

    return (
      <picker
        actions={actions(a, true)}
        columns={[
          { format: 'dim', head: 'At', id: 'at', min: 8, priority: 2 },
          { format: 'elapsed', head: 'Took', id: 'took', priority: 4 }
        ]}
        confirm={stopping ? { act: 'confirm', label: 'Stop', text: `Stop ${agentName(a)}? Its partial work returns to Hermes.` } : undefined}
        empty={a.logPath || a.log ? 'Nothing logged yet' : 'This agent has no live transcript'}
        icon="agent"
        items={entries.map((e, i) => stepItem(e, `e${i}`, a))}
        key={KEY}
        layout="timeline"
        noun="steps"
        onAction={handlers}
        onSelect={ev => {
          step = ev.item === ids.at(-1) ? undefined : ev.item
          app.changed()
        }}
        preview="side"
        selected={sel}
        size="lg"
        subtitle={[{ s: 'muted', t: `${STATUS[a.status]} · ${a.goal}` }]}
        title={agentName(a)}
        total={entries.length}
        {...steerProps(a)}
      >
        {at >= 0 ? stepPreview(entries[at]!, a, briefFor(app, a)) : [agentNode(a, now)]}
      </picker>
    )
  }

  app.open(overlay)

  if (focus?.watch) {
    watch(focus.id)
  }
}

function summary(all: Subagent[]): string {
  const count = (s: Subagent['status']) => all.filter(a => a.status === s).length
  const parts = [
    [count('running') + count('queued'), 'running'],
    [count('done'), 'done'],
    [count('failed'), 'failed'],
    [count('cancelled'), 'stopped']
  ] as const

  return parts.filter(([n]) => n).map(([n, label]) => `${n} ${label}`).join(' · ') || 'none yet'
}

function elapsed(a: Subagent, now: number): string {
  return duration(isRunning(a) ? now - a.startedAt : (a.duration ?? 0))
}

function hubItem(a: Subagent, now: number): PickerItem {
  return {
    chips: a.model ? [{ text: a.model.split('/').at(-1) ?? a.model }] : undefined,
    depth: a.depth ?? 0,
    detail: a.goal,
    dot: DOT[a.status],
    facts: { time: elapsed(a, now), tools: a.toolCount },
    id: a.id,
    label: agentName(a),
    title: a.goal
  }
}

/** The brief agent `a` was given with its goal, from the delegation that started it. */
function briefFor(app: App, a: Subagent): string | undefined {
  const call = app.transcript.delegations().find(c => c.subagents?.includes(a))

  return call ? briefOf(call, a.index) : undefined
}

function hubPreview(a: Subagent, now: number, brief?: string): JSX.Element[] {
  const recent = (a.log?.entries ?? []).slice(-RECENT)

  return [
    // A new node each time the selection moves: its timers need their true ages.
    agentNode(a, now),
    <kv
      items={[
        { k: [{ t: 'Status' }], v: [{ s: toneSpan(a.status), t: STATUS[a.status] }] },
        ...(a.model ? [{ k: [{ t: 'Model' }], v: a.model }] : []),
        { k: [{ t: 'Time' }], v: elapsed(a, now) },
        { k: [{ t: 'Tools' }], v: String(a.toolCount) },
        ...(a.exitReason ? [{ k: [{ t: 'Ended' }], v: a.exitReason.replace(/_/g, ' ') }] : []),
        ...(isRunning(a) && a.steerable !== undefined
          ? [{ k: [{ t: 'Steering' }], v: a.steerable ? 'open' : 'closed' }]
          : []),
        { k: [{ t: 'ID' }], v: [{ s: 'mono dim', t: a.id }] }
      ]}
      key="facts"
      role="omp.hub.kv"
    />,
    <section head="Task" key="task">
      <md key="goal" text={a.goal} />
    </section>,
    ...(brief
      ? [
          <section collapsed collapsible head="Brief" key="brief">
            <md key="text" text={brief} />
          </section>
        ]
      : []),
    ...(a.summary
      ? [
          <section head="Result" key="result">
            <md key="summary" text={a.summary} />
          </section>
        ]
      : []),
    ...(recent.length
      ? [
          <section head="Recent activity" key="recent" role="omp.hub.activity">
            {recent.map((e, i) => (
              <row gap="sm" key={`r${i}`} role="omp.hub.activity.row">
                <text key="at" spans={[{ s: 'dim mono', t: e.at }]} wrap="none" />
                <text grow={1} key="what" spans={stepSpans(e)} truncate="end" wrap="none" />
              </row>
            ))}
          </section>
        ]
      : [])
  ]
}

function stepItem(e: LogEntry, id: string, a: Subagent): PickerItem {
  if (e.kind === 'tool') {
    return {
      detail: e.args,
      dot: e.status === 'error' ? 'error' : e.status === 'running' && isRunning(a) ? 'accent' : undefined,
      facts: { at: e.at, took: e.took !== undefined ? duration(e.took) : '' },
      icon: TOOL_ICON[e.name] ?? 'wrench',
      id,
      label: e.name,
      mono: true,
      node: 'tool',
      tone: e.status === 'error' ? 'error' : undefined
    }
  }

  return {
    facts: { at: e.at },
    id,
    label: e.kind === 'kickoff' ? `Task: ${e.text}` : e.kind === 'think' ? `Thinking: ${e.text}` : e.text,
    node: e.kind === 'kickoff' ? 'user' : 'assistant',
    tone: e.kind === 'think' || e.kind === 'note' ? 'muted' : undefined
  }
}

/**
 * One step of `a`'s timeline. Its kickoff is the whole prompt the agent got, from the delegation
 * (the goal, then its `brief`): the log keeps only a capped, flattened copy.
 */
function stepPreview(e: LogEntry, a: Subagent, brief?: string): JSX.Element[] {
  if (e.kind !== 'tool') {
    const head = { assistant: 'Answer', kickoff: 'Task', note: 'Note', think: 'Thinking' }[e.kind]
    const text = e.kind === 'kickoff' && a.goal ? (brief ? `${a.goal}\n\n---\n\n${brief}` : a.goal) : e.text

    return [
      <text key="title" role="omp.hub.title" text={head} />,
      <text key="at" spans={[{ s: 'dim mono', t: e.at }]} />,
      <md key="body" text={text} tone={e.kind === 'think' ? 'muted' : undefined} />
    ]
  }

  return [
    <text key="title" role="omp.hub.title" spans={[{ s: 'mono strong', t: e.name }]} />,
    <kv
      items={[
        {
          k: [{ t: 'Status' }],
          v: [{ s: e.status === 'error' ? 'error' : e.status === 'ok' ? 'success' : 'accent', t: e.status === 'ok' ? 'ok' : e.status }]
        },
        { k: [{ t: 'Started' }], v: e.at },
        ...(e.took !== undefined ? [{ k: [{ t: 'Took' }], v: duration(e.took) }] : [])
      ]}
      key="facts"
      role="omp.hub.kv"
    />,
    ...(e.args
      ? [
          <section head="Arguments" key="args">
            <code key="code" text={e.args} wrap />
          </section>
        ]
      : []),
    ...(e.result
      ? [
          <section head="Result" key="result">
            <code key="code" text={e.result} wrap />
          </section>
        ]
      : [])
  ]
}

function stepSpans(e: LogEntry): { s?: string; t: string }[] {
  switch (e.kind) {
    case 'tool':
      return [
        { s: e.status === 'error' ? 'error mono' : 'mono', t: e.name },
        { s: 'muted', t: ` ${e.args}` }
      ]

    case 'think':
      return [{ s: 'muted', t: e.text }]

    case 'kickoff':
      return [{ s: 'dim', t: 'Task: ' }, { t: e.text }]

    default:
      return [{ t: e.text }]
  }
}

function toneSpan(status: Subagent['status']): string {
  return { cancelled: 'warning', done: 'success', failed: 'error', queued: 'muted', running: 'accent' }[status]
}
