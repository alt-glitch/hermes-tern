// The agents hub (`/agents`, ⌥A, the agents pill): every subagent of the session in one
// `picker` sheet, as omp's hub draws them (a tree when orchestrators spawned workers, status
// dots, tool counts and timers), the selected one previewed as its live `agent` row, facts and
// latest activity. Enter opens the agent beside the chat (watch/: its full transcript, live,
// with a composer that steers it). T opens its timeline in this sheet instead (its live
// transcript log, one row per step, following the newest). S steers a running agent (the
// search line becomes the message), X stops it. P pauses (or resumes) new spawns, gateway-wide.

import type { JSX, Key, PickerColumn, PickerItem } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import type { Subagent } from '../model.js'
import type { Overlay } from '../overlay.js'

import { agentNode } from '../agents/agentRow.js'
import {
  currentAgent,
  HUB_CLICKS,
  type HubAction,
  type HubEffect,
  hubKey,
  type HubState,
  initialHub,
  reduceHub,
  shownAgents,
  stepIds
} from '../agents/hub.js'
import type { LogEntry } from '../agents/liveLog.js'
import { SUBAGENT_LOOK } from '../agents/look.js'
import { agentName, isRunning } from '../agents/store.js'
import { duration } from '../view/format.js'
import { briefOf } from '../view/tools/cards/task.js'
import { hubIconOf } from '../view/tools/registry.js'
import { facts } from '../view/ui/facts.js'

import { countSummary, reportError, tickWhileOpen } from './sheet.js'

/** What the agents hub reaches of the app. */
export type AgentsSheetHost = Pick<ChatPorts, 'agents' | 'changed' | 'close' | 'open' | 'openAgent' | 'transcript'>

const KEY = 'agents'
/** Timers and the timeline follow the clock while the sheet is open. */
const TICK_MS = 1000
const RECENT = 6

/** Opens the hub, on agent `focus` when given (its timeline when `watch`). */
export function openAgents(host: AgentsSheetHost, focus?: { id: string; watch?: boolean }) {
  const agents = () => host.agents.all()
  let state: HubState = initialHub(agents(), focus?.id)

  const stopTicking = tickWhileOpen(host, TICK_MS)
  const close = () => host.close(overlay)

  const sendSteer = async (a: Subagent, text: string) => {
    await reportError(host.transcript, async () => {
      const queued = await host.agents.steer(a, text)
      host.transcript.notice(
        queued ? `Steering queued for ${agentName(a)}.` : `${agentName(a)} is not taking steering now.`,
        queued ? 'info' : 'warning'
      )
    })

    host.changed()
  }

  const stop = async (a: Subagent) => {
    await reportError(host.transcript, async () => {
      if (!(await host.agents.stop(a))) {
        host.transcript.notice(`${agentName(a)} already finished.`, 'warning')
      }
    })

    host.changed()
  }

  /** Blocks or unblocks new spawns (`delegation.pause`, every chat on the gateway); running agents keep going. */
  const togglePause = async () => {
    await reportError(host.transcript, async () => {
      const paused = await host.agents.pause(!host.agents.paused)
      host.transcript.notice(paused ? 'Subagent spawning paused for every chat on this gateway.' : 'Subagent spawning resumed.')
    })

    host.changed()
  }

  const run = (effect: HubEffect) => {
    switch (effect.kind) {
      case 'close':
        return close()

      case 'beside':
        // Opens the agent in a split beside the chat and closes the hub; its timeline here when no split can open.
        close()

        return void host.openAgent(effect.id)

      case 'refresh':
        return void host.agents.refresh(effect.agent)

      case 'steer':
        return void sendSteer(effect.agent, effect.text)

      case 'stop':
        return void stop(effect.agent)

      case 'pause':
        return void togglePause()
    }
  }

  /** Applies `action` and runs its effect; a click also re-renders (a key's render follows the key). */
  const act = (action: HubAction | undefined) => {
    if (!action) {
      return
    }

    const step = reduceHub(state, action, agents())
    state = step.state

    if (step.effect) {
      run(step.effect)
    }
  }

  const click = (action: HubAction) => {
    act(action)
    host.changed()
  }

  const handlers = Object.fromEntries(
    Object.entries(HUB_CLICKS).map(([id, action]) => [id, (ev: { value?: string }) => click(action(ev))])
  )

  const overlay: Overlay = {
    key: KEY,
    modal: true,
    cancel: close,
    // Ends with the sheet, however it closed (Esc, a session switch replacing the overlays).
    onClose: stopTicking,
    node: () => {
      const now = Date.now()
      const watched = state.view.kind === 'timeline' ? currentAgent(state, agents()) : undefined

      return watched ? timelineNode(watched, now) : hubNode(now)
    },
    onKey: (k: Key) => {
      act(hubKey(state, k, agents()))

      return true
    }
  }

  const steerProps = (a: Subagent | undefined) =>
    state.ask.kind === 'steering' && a
      ? { placeholder: `Steer ${agentName(a)}: type, then Enter (Esc cancels)`, query: state.ask.text }
      : {}

  const actions = (a: Subagent | undefined, inTimeline: boolean) => {
    const running = Boolean(a && isRunning(a))

    if (state.ask.kind === 'steering') {
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
            { id: 'pause', keys: ['p'], label: host.agents.paused ? 'Resume spawns' : 'Pause spawns' }
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

  const stopping = () => state.ask.kind === 'confirmStop'

  function hubNode(now: number): JSX.Element {
    const all = agents()
    const list = shownAgents(state, all)
    const running = all.filter(isRunning).length

    act({ ids: list.map(x => x.id), type: 'listed' })

    const a = list.find(x => x.id === state.selected)
    const columns: PickerColumn[] = [
      { format: 'num', head: 'Tools', id: 'tools', priority: 3 },
      { format: 'elapsed', head: 'Time', id: 'time', priority: 5 }
    ]

    return (
      <picker
        actions={actions(a, false)}
        columns={columns}
        confirm={stopping() && a ? { act: 'confirm', label: 'Stop', text: `Stop ${agentName(a)}? Its partial work returns to Hermes.` } : undefined}
        empty={state.tab === 'running' ? 'No agents running. Tab shows finished ones.' : 'No subagents in this session yet'}
        icon="agents"
        items={all.map(x => hubItem(x, now))}
        key={KEY}
        layout={all.some(x => x.depth) ? 'tree' : 'rows'}
        noun="agents"
        onAction={handlers}
        onActivate={ev => act({ id: ev.item, type: 'beside' })}
        onSelect={ev => click({ id: ev.item, type: 'select' })}
        order={list.map(x => x.id)}
        preview="side"
        selected={state.selected}
        size="lg"
        subtitle={[
          { s: 'muted', t: summary(all) },
          ...(host.agents.paused ? [{ s: 'warning', t: ' · spawns paused (gateway-wide)' }] : [])
        ]}
        tab={state.tab}
        tabs={[
          { count: running, id: 'running', label: 'Running' },
          { count: all.length, id: 'all', label: 'All' }
        ]}
        title="Agents"
        total={all.length}
        {...steerProps(a)}
      >
        {a ? hubPreview(a, now, briefFor(host, a)) : null}
      </picker>
    )
  }

  function timelineNode(a: Subagent, now: number): JSX.Element {
    const entries = a.log?.entries ?? []
    const ids = stepIds(a)
    const step = state.view.kind === 'timeline' ? state.view.step : undefined
    const sel = step && ids.includes(step) ? step : ids.at(-1)
    const at = sel ? ids.indexOf(sel) : -1
    const shown = entries[at]

    return (
      <picker
        actions={actions(a, true)}
        columns={[
          { format: 'dim', head: 'At', id: 'at', min: 8, priority: 2 },
          { format: 'elapsed', head: 'Took', id: 'took', priority: 4 }
        ]}
        confirm={stopping() ? { act: 'confirm', label: 'Stop', text: `Stop ${agentName(a)}? Its partial work returns to Hermes.` } : undefined}
        empty={a.logPath || a.log ? 'Nothing logged yet' : 'This agent has no live transcript'}
        icon="agent"
        items={entries.map((e, i) => stepItem(e, `e${i}`, a))}
        key={KEY}
        layout="timeline"
        noun="steps"
        onAction={handlers}
        onSelect={ev => click({ id: ev.item, type: 'step' })}
        preview="side"
        selected={sel}
        size="lg"
        subtitle={[{ s: 'muted', t: `${SUBAGENT_LOOK[a.status].word} · ${a.goal}` }]}
        title={agentName(a)}
        total={entries.length}
        {...steerProps(a)}
      >
        {shown ? stepPreview(shown, a, briefFor(host, a)) : [agentNode(a, now)]}
      </picker>
    )
  }

  host.open(overlay)

  if (focus?.watch) {
    act({ type: 'watch' })
  }
}

function summary(all: Subagent[]): string {
  return countSummary(all, [
    [a => a.status === 'running' || a.status === 'queued', 'running'],
    [a => a.status === 'done', 'done'],
    [a => a.status === 'failed', 'failed'],
    [a => a.status === 'cancelled', 'stopped']
  ])
}

function elapsed(a: Subagent, now: number): string {
  return duration(isRunning(a) ? now - a.startedAt : (a.duration ?? 0))
}

function hubItem(a: Subagent, now: number): PickerItem {
  return {
    chips: a.model ? [{ text: a.model.split('/').at(-1) ?? a.model }] : undefined,
    depth: a.depth ?? 0,
    detail: a.goal,
    dot: SUBAGENT_LOOK[a.status].tone,
    facts: { time: elapsed(a, now), tools: a.toolCount },
    id: a.id,
    label: agentName(a),
    title: a.goal
  }
}

/** The brief agent `a` was given with its goal, from the delegation that started it. */
function briefFor(host: AgentsSheetHost, a: Subagent): string | undefined {
  const call = host.transcript.delegations().find(c => c.subagents?.includes(a))

  return call ? briefOf(call, a.index) : undefined
}

function hubPreview(a: Subagent, now: number, brief?: string): JSX.Element[] {
  const recent = (a.log?.entries ?? []).slice(-RECENT)
  const look = SUBAGENT_LOOK[a.status]

  return [
    // A new node each time the selection moves: its timers need their true ages.
    agentNode(a, now),
    <kv
      items={facts([
        ['Status', [{ s: look.tone, t: look.word }]],
        ['Model', a.model],
        ['Time', elapsed(a, now)],
        ['Tools', String(a.toolCount)],
        ['Ended', a.exitReason?.replace(/_/g, ' ')],
        ['Steering', isRunning(a) && a.steerable !== undefined ? (a.steerable ? 'open' : 'closed') : undefined],
        ['ID', [{ s: 'mono dim', t: a.id }]]
      ])}
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
      icon: hubIconOf(e.name),
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
      items={facts([
        ['Status', [{ s: e.status === 'error' ? 'error' : e.status === 'ok' ? 'success' : 'accent', t: e.status === 'ok' ? 'ok' : e.status }]],
        ['Started', e.at],
        ['Took', e.took !== undefined ? duration(e.took) : undefined]
      ])}
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

    case 'assistant':

    case 'note':
      return [{ t: e.text }]
  }
}
