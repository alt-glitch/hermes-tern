// The Background sheet (`/ps`, ⌥J, the shells pill, a background terminal card): the session's
// background processes in one `picker`, as Claude Code lists its background shells. Each row is
// the command's readable title with the command dim, its status, its run time and its last
// output line; the preview shows the process's facts and its output, following the end. Enter
// gives the output the whole sheet, K stops the selected process, Shift+K stops them all (both
// ask first), C copies the command. The Cron tab lists every Hermes cron job and monitor: P
// pauses or resumes the selected one, D removes it (asking first).

import type { JSX, Key, PickerColumn, PickerItem } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import { copyToClipboard } from '../clipboard.js'
import type { BackgroundProcess, ToolCall } from '../model.js'
import type { Overlay } from '../overlay.js'
import { type CronJob, isMonitor, isPaused, jobError, jobTone, ownJobs, relative } from '../processes/cron.js'
import { PROCESS_LOOK } from '../processes/look.js'
import {
  isRunning,
  processElapsed,
  processIdOf,
  processTone,
  processVerdict,
  watchersOf,
  type Watchers
} from '../processes/store.js'
import { chartNode } from '../processes/widgets/view.js'
import { isBackgroundCall } from '../transcript/calls.js'
import { commandLine, describeCommand, oneLine } from '../view/describe.js'
import { clockSeconds, duration, plural } from '../view/format.js'
import { type Fact, facts } from '../view/ui/facts.js'

import { moveSelection } from './search.js'
import { countSummary, reportError, tickWhileOpen } from './sheet.js'

/** What the Background sheet reaches of the app. */
export type BackgroundHost = Pick<ChatPorts, 'changed' | 'close' | 'cron' | 'open' | 'processes' | 'transcript'>

const KEY = 'background'
/** Run times follow the clock while the sheet is open. */
const TICK_MS = 1000
const COPIED_MS = 1500

type Tab = 'all' | 'cron' | 'running'

const TABS: Tab[] = ['running', 'all', 'cron']

/** Opens the sheet, on process `focus` when given, or on the Cron tab (`/cron`). */
export function openBackground(host: BackgroundHost, at?: string | { tab: 'cron' }) {
  const procs = () => host.processes.all()
  const focus = typeof at === 'string' ? at : undefined
  const focused = focus ? host.processes.get(focus) : undefined
  let tab: Tab = focused ? (isRunning(focused) ? 'running' : 'all') : host.processes.running().length ? 'running' : 'all'

  if (typeof at === 'object') {
    tab = at.tab
  }

  let selected = focus ?? procs().find(isRunning)?.id ?? procs()[0]?.id
  /** Enter: the output takes the whole sheet. */
  let expanded = false
  let confirm: 'all' | 'job' | 'one' | undefined
  let job: string | undefined
  let copied: string | undefined
  let copiedTimer: NodeJS.Timeout | undefined
  const release = host.processes.watch()
  const releaseCron = host.cron.watch()

  const stopTicking = tickWhileOpen(host, TICK_MS)
  const close = () => host.close(overlay)

  const shown = (): BackgroundProcess[] => (tab === 'running' ? procs().filter(isRunning) : procs())
  const current = () => procs().find(p => p.id === selected)

  const stopOne = async () => {
    const p = current()
    confirm = undefined

    if (!p || !isRunning(p)) {
      return host.changed()
    }

    await reportError(host.transcript, async () => {
      const status = await host.processes.kill(p.id)

      if (status && status !== 'killed') {
        host.transcript.notice(`${describeCommand(p.command)}: ${status.replace(/_/g, ' ')}.`, 'warning')
      }
    })

    host.changed()
  }

  const stopAll = async () => {
    confirm = undefined

    await reportError(host.transcript, async () => {
      const n = await host.processes.stopAll()
      host.transcript.notice(`Stopped ${plural(n, 'background process', 'background processes')}.`)
    })

    host.changed()
  }

  const copy = () => {
    const p = current()

    if (!p) {
      return
    }

    copyToClipboard(p.command)
    copied = p.id
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      copied = undefined
      host.changed()
    }, COPIED_MS)
    host.changed()
  }

  const ask = (what: 'all' | 'one') => {
    const p = current()

    if (what === 'one' ? p && isRunning(p) && !host.processes.stopping(p.id) : host.processes.running().length) {
      confirm = what
    }
  }

  const currentJob = () => host.cron.jobs().find(j => j.job_id === job)

  const actJob = async (action: 'pause' | 'remove' | 'resume') => {
    const j = currentJob()
    confirm = undefined

    if (!j || host.cron.busy(j.job_id)) {
      return host.changed()
    }

    await reportError(host.transcript, () => host.cron.act(action, j.job_id))

    host.changed()
  }

  const toggleJob = () => {
    const j = currentJob()

    if (j) {
      void actJob(isPaused(j) ? 'resume' : 'pause')
    }
  }

  const askRemove = () => {
    if (currentJob()) {
      confirm = 'job'
    }
  }

  const settle = () => void (confirm === 'all' ? stopAll() : confirm === 'job' ? actJob('remove') : stopOne())

  const overlay: Overlay = {
    key: KEY,
    modal: true,
    cancel: close,
    // Ends with the sheet, however it closed (Esc, a session switch replacing the overlays).
    onClose: () => {
      stopTicking()
      clearTimeout(copiedTimer)
      release()
      releaseCron()
    },
    node: () => sheetNode(Date.now()),
    onKey: (k: Key) => {
      if (confirm) {
        if (k.name === 'enter' || k.name === 'y') {
          settle()
        } else if (k.name === 'escape' || k.name === 'n') {
          confirm = undefined
        }

        return true
      }

      const bare = !k.ctrl && !k.alt && !k.meta

      if (k.name === 'escape') {
        if (expanded) {
          expanded = false
        } else {
          close()
        }
      } else if (tab === 'cron') {
        if (k.name === 'tab') {
          tab = next(tab, k.shift)
        } else if (k.name === 'p' && bare && !k.shift) {
          toggleJob()
        } else if (k.name === 'd' && bare && !k.shift) {
          askRemove()
        } else {
          job =
            moveSelection(
              k,
              host.cron.jobs().map(j => j.job_id),
              job
            ) ?? job
        }
      } else if (k.name === 'enter') {
        expanded = Boolean(current()) && !expanded
      } else if (k.name === 'k' && bare) {
        ask(k.shift ? 'all' : 'one')
      } else if (k.name === 'c' && bare && !k.shift) {
        copy()
      } else if (k.name === 'tab' && !expanded) {
        tab = next(tab, k.shift)
      } else {
        selected =
          moveSelection(
            k,
            shown().map(p => p.id),
            selected
          ) ?? selected
      }

      return true
    }
  }

  const handlers = {
    all: () => {
      ask('all')
      host.changed()
    },
    cancel: () => {
      confirm = undefined
      host.changed()
    },
    close: () => {
      if (expanded) {
        expanded = false
        host.changed()
      } else {
        close()
      }
    },
    confirm: settle,
    copy,
    expand: () => {
      expanded = Boolean(current()) && !expanded
      host.changed()
    },
    remove: () => {
      askRemove()
      host.changed()
    },
    stop: () => {
      ask('one')
      host.changed()
    },
    tab: (ev: { value?: string }) => {
      tab = TABS.find(t => t === ev.value) ?? 'all'
      expanded = false
      confirm = undefined
      host.changed()
    },
    toggle: toggleJob
  }

  function sheetNode(now: number): JSX.Element {
    return tab === 'cron' ? cronNode(now) : processNode(now)
  }

  const tabs = () => [
    { count: host.processes.running().length, id: 'running', label: 'Running' },
    { count: procs().length, id: 'all', label: 'All' },
    { count: host.cron.loaded ? host.cron.jobs().length : undefined, id: 'cron', label: 'Cron' }
  ]

  function cronNode(now: number): JSX.Element {
    const jobs = host.cron.jobs()
    const own = ownJobs(host.transcript.calls('cronjob_manage'))

    if (!jobs.some(j => j.job_id === job)) {
      job = jobs[0]?.job_id
    }

    const j = jobs.find(x => x.job_id === job)
    const busy = j ? host.cron.busy(j.job_id) : false
    const columns: PickerColumn[] = [
      { format: 'dim', head: 'Schedule', id: 'schedule', min: 10, priority: 1 },
      { format: 'dim', head: 'Next', id: 'next', priority: 3 },
      { format: 'dim', head: 'Last', id: 'last', priority: 5 }
    ]

    return (
      <picker
        actions={[
          {
            disabled: j ? (busy ? 'Working' : undefined) : 'No job',
            id: 'toggle',
            keys: ['p'],
            label: j && isPaused(j) ? 'Resume' : 'Pause',
            primary: true
          },
          { danger: true, disabled: j ? (busy ? 'Working' : undefined) : 'No job', id: 'remove', keys: ['d'], label: 'Remove' },
          { end: true, id: 'close', keys: ['esc'], label: 'Close' }
        ]}
        columns={columns}
        confirm={confirm === 'job' && j ? { act: 'confirm', label: 'Remove', text: `Remove ${j.name || j.job_id}? It will not run again.` } : undefined}
        empty={
          host.cron.error
            ? `Could not list cron jobs: ${host.cron.error}`
            : host.cron.loaded
              ? 'No cron jobs. Ask Hermes to schedule one or to watch something.'
              : 'Loading cron jobs…'
        }
        icon="clock"
        items={jobs.map(x => jobItem(x, now, own.has(x.job_id), host.cron.busy(x.job_id)))}
        key={KEY}
        noun="jobs"
        onAction={handlers}
        onSelect={ev => {
          job = ev.item
          confirm = undefined
          host.changed()
        }}
        order={jobs.map(x => x.job_id)}
        preview="side"
        selected={job}
        size="lg"
        subtitle={[{ s: 'muted', t: host.cron.warning ?? cronSummary(jobs) }]}
        tab={tab}
        tabs={tabs()}
        title="Background"
        total={jobs.length}
      >
        {j ? jobPreview(j, now, own.has(j.job_id)) : null}
      </picker>
    )
  }

  function processNode(now: number): JSX.Element {
    const all = procs()
    const list = shown()
    const running = all.filter(isRunning).length

    if (!list.some(p => p.id === selected)) {
      selected = list[0]?.id
    }

    const p = list.find(x => x.id === selected)
    const call = p && callOf(host, p.id)
    const columns: PickerColumn[] = [
      { format: 'dim', head: 'Last output', id: 'last', min: 16, priority: 1 },
      { format: 'dim', head: 'Status', id: 'status', priority: 3 },
      { format: 'elapsed', head: 'Time', id: 'time', priority: 5 }
    ]

    return (
      <picker
        actions={[
          { id: 'expand', keys: ['enter'], label: expanded ? 'List' : 'Output', primary: true },
          { id: 'copy', keys: ['c'], label: copied && copied === p?.id ? 'Copied' : 'Copy command' },
          {
            danger: true,
            disabled: p && isRunning(p) ? (host.processes.stopping(p.id) ? 'Stopping' : undefined) : 'Not running',
            id: 'stop',
            keys: ['k'],
            label: p && host.processes.stopping(p.id) ? 'Stopping…' : 'Stop'
          },
          { danger: true, disabled: running ? undefined : 'None running', id: 'all', keys: ['shift+k'], label: 'Stop all' },
          { end: true, id: 'close', keys: ['esc'], label: expanded ? 'Back' : 'Close' }
        ]}
        columns={columns}
        confirm={
          confirm === 'all'
            ? { act: 'confirm', label: 'Stop all', text: `Stop ${plural(running, 'background process', 'background processes')}?` }
            : confirm === 'one' && p
              ? { act: 'confirm', label: 'Stop', text: `Stop ${describeCommand(p.command)}?` }
              : undefined
        }
        empty={tab === 'running' ? 'No background processes running. Tab shows the finished ones.' : 'No background processes in this session'}
        focus={expanded ? 'preview' : undefined}
        icon="terminal"
        items={all.map(x => item(x, now, host.processes.stopping(x.id)))}
        key={KEY}
        noun="processes"
        onAction={handlers}
        onActivate={ev => {
          selected = ev.item
          expanded = true
          host.changed()
        }}
        onSelect={ev => {
          selected = ev.item
          confirm = undefined
          host.changed()
        }}
        order={list.map(x => x.id)}
        preview="side"
        selected={selected}
        size="lg"
        subtitle={[{ s: 'muted', t: summary(all) }]}
        tab={tab}
        tabs={tabs()}
        title="Background"
        total={all.length}
      >
        {p ? (expanded ? outputView(p, now) : preview(p, call, now)) : null}
      </picker>
    )
  }

  host.open(overlay)
}

function next(tab: Tab, back: boolean): Tab {
  return TABS[(TABS.indexOf(tab) + (back ? TABS.length - 1 : 1)) % TABS.length]!
}

function cronSummary(jobs: CronJob[]): string {
  return countSummary(jobs, [
    [j => !isPaused(j), 'active'],
    [isPaused, 'paused'],
    [isMonitor, ['monitor', 'monitors']]
  ])
}

function jobItem(j: CronJob, now: number, own: boolean, busy: boolean): PickerItem {
  const error = jobError(j)

  return {
    badges: [...(isMonitor(j) ? [{ text: 'monitor' }] : []), ...(own ? [{ text: 'this session', tone: 'accent' as const }] : [])],
    detail: oneLine(j.prompt_preview || j.monitor_url || j.monitor_script || '') || undefined,
    dot: jobTone(j),
    facts: {
      last: busy ? 'working…' : error ? 'failed' : j.last_run_at ? `${j.last_status ?? 'ran'} ${relative(j.last_run_at, now)}` : 'never ran',
      next: isPaused(j) ? 'paused' : relative(j.next_run_at, now),
      schedule: j.schedule ?? ''
    },
    id: j.job_id,
    label: j.name || j.job_id,
    tone: isPaused(j) ? 'muted' : undefined
  }
}

function jobPreview(j: CronJob, now: number, own: boolean): JSX.Element[] {
  const at = (iso: string | null | undefined) => (iso ? `${clockSeconds(Date.parse(iso))} · ${relative(iso, now)}` : '—')
  const error = jobError(j)

  return [
    <text key="title" role="omp.hub.title" text={j.name || j.job_id} />,
    <kv
      items={facts([
        ['State', [{ s: jobTone(j), t: isPaused(j) ? `Paused${j.paused_reason ? ` · ${j.paused_reason}` : ''}` : 'Active' }]],
        ['Schedule', j.schedule],
        ['Next run', !isPaused(j) && at(j.next_run_at)],
        ['Last run', j.last_run_at ? `${at(j.last_run_at)}${j.last_status ? ` · ${j.last_status}` : ''}` : 'never'],
        ['Repeat', j.repeat === null || j.repeat === undefined ? undefined : String(j.repeat)],
        ['Delivers to', j.deliver],
        ['Watches', j.monitor_url ?? j.monitor_script],
        ['Script', j.script],
        ['Folder', j.workdir],
        ['Model', j.model],
        ['Skills', j.skills?.join(' · ')],
        ['Made by', own && 'this session'],
        ['Job', [{ s: 'mono dim', t: j.job_id }]]
      ])}
      key="facts"
      role="omp.hub.kv"
    />,
    ...(error ? [<text key="error" spans={[{ s: 'error', t: error }]} />] : []),
    ...(j.prompt_preview
      ? [
          <section head="Prompt" key="prompt">
            <md key="text" text={j.prompt_preview} />
          </section>
        ]
      : []),
    ...(j.monitor_state !== undefined && j.monitor_state !== null
      ? [
          <section head="Last seen" key="state">
            <code key="json" lang="json" max={{ h: '10lines' }} text={JSON.stringify(j.monitor_state, null, 2)} wrap />
          </section>
        ]
      : [])
  ]
}

/** The terminal call that started process `id`, for its watchers. */
function callOf(host: BackgroundHost, id: string): ToolCall | undefined {
  return host.transcript.backgroundCalls().find(c => isBackgroundCall(c) && (processIdOf(c) ?? c.process?.id) === id)
}

function summary(all: BackgroundProcess[]): string {
  return countSummary(all, [
    [p => p.status === 'running', 'running'],
    [p => p.status === 'done', 'exited'],
    [p => p.status === 'failed', 'failed'],
    [p => p.status === 'killed' || p.status === 'lost', 'stopped']
  ])
}

function item(p: BackgroundProcess, now: number, stopping: boolean): PickerItem {
  return {
    detail: commandLine(p.command, 120),
    dot: processTone(p.status),
    facts: {
      last: p.lastLine || (isRunning(p) ? 'starting…' : ''),
      status: stopping ? 'stopping…' : isRunning(p) ? 'running' : processVerdict(p),
      time: duration(processElapsed(p, now))
    },
    id: p.id,
    label: describeCommand(p.command),
    title: p.command,
    tone: isRunning(p) ? undefined : 'muted'
  }
}

function preview(p: BackgroundProcess, call: ToolCall | undefined, now: number): JSX.Element[] {
  const w = call ? watchersOf(call) : undefined

  return [
    <text key="title" role="omp.hub.title" text={describeCommand(p.command)} />,
    <code key="cmd" lang="bash" max={{ h: '6lines' }} role="omp.tool.command" text={p.command} wrap />,
    <kv
      items={facts([
        ['Status', [{ s: processTone(p.status), t: isRunning(p) ? PROCESS_LOOK.running.word : `${PROCESS_LOOK[p.status].word} · ${processVerdict(p)}` }]],
        ['Started', clockSeconds(p.startedAt)],
        [isRunning(p) ? 'Running for' : 'Ran for', duration(processElapsed(p, now))],
        ['Exited', p.exitedAt ? `${clockSeconds(p.exitedAt)} · ${duration(now - p.exitedAt)} ago` : undefined],
        ['Reason', p.status !== 'running' && p.reason?.replace(/_/g, ' ')],
        ...(w ? watcherFacts(w) : []),
        ['Process', [{ s: 'mono dim', t: p.id }]]
      ])}
      key="facts"
      role="omp.hub.kv"
    />,
    // The chart once its rules are being written or drive it; a plain count of lines says nothing the output does not.
    ...(p.chart && p.chart.state !== 'fallback' ? [<section head="Chart" key="chart">{chartNode(p.chart)}</section>] : []),
    <section head="Output" key="output">
      {outputNodes(p)}
    </section>
  ]
}

/** The output in a box of `lines` that follows its end. */
function outputNodes(p: BackgroundProcess, lines = 14): JSX.Element[] {
  return p.output
    ? [<ansi follow key="out" max={{ h: `${lines}lines` }} text={p.output.replace(/\n$/, '')} />]
    : [<text key="none" spans={[{ s: 'muted', t: isRunning(p) ? 'No output yet' : 'It printed nothing' }]} />]
}

/** Enter: the preview gives the output all its height. */
function outputView(p: BackgroundProcess, now: number): JSX.Element[] {
  return [
    <text key="title" role="omp.hub.title" text={describeCommand(p.command)} />,
    <text
      key="state"
      spans={[
        { s: processTone(p.status), t: isRunning(p) ? 'running' : processVerdict(p) },
        { s: 'muted', t: ` · ${duration(processElapsed(p, now))}` }
      ]}
    />,
    ...outputNodes(p, 34)
  ]
}

function watcherFacts(w: Watchers): Fact[] {
  return [
    ['Notify', w.notify ? 'when it exits' : w.patterns.length ? 'on a matching line' : 'off'],
    ['Watch', w.patterns.join(' · ')],
    ['Heartbeat', w.heartbeat ? `every ${w.heartbeat}s` : undefined]
  ]
}
