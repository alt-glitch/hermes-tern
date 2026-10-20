// The Background sheet (`/ps`, ⌥J, the shells pill, a background terminal card): the session's
// background processes in one `picker`, as Claude Code lists its background shells. Each row is
// the command's readable title with the command dim, its status, its run time and its last
// output line; the preview shows the process's facts and its output, following the end. Enter
// gives the output the whole sheet, K stops the selected process, Shift+K stops them all (both
// ask first), C copies the command. The Cron tab lists every Hermes cron job and monitor: P
// pauses or resumes the selected one, D removes it (asking first).

import type { JSX, Key, PickerColumn, PickerItem } from '@stencil-hq/tern'

import type { App } from '../app.js'
import { copyToClipboard } from '../clipboard.js'
import type { BackgroundProcess, ToolCall } from '../model.js'
import type { Overlay } from '../overlay.js'
import { type CronJob, isMonitor, isPaused, jobError, jobTone, ownJobs, relative } from '../processes/cron.js'
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
import { isBackgroundCall } from '../transcript.js'
import { commandLine, describeCommand, oneLine } from '../view/describe.js'
import { duration } from '../view/time.js'

import { moveSelection } from './search.js'

const KEY = 'background'
/** Run times follow the clock while the sheet is open. */
const TICK_MS = 1000
const COPIED_MS = 1500

type Tab = 'all' | 'cron' | 'running'

const TABS: Tab[] = ['running', 'all', 'cron']

const STATUS: Record<BackgroundProcess['status'], string> = {
  done: 'Exited',
  failed: 'Failed',
  killed: 'Stopped',
  lost: 'Lost',
  running: 'Running'
}

/** Opens the sheet, on process `focus` when given, or on the Cron tab (`/cron`). */
export function openBackground(app: App, at?: string | { tab: 'cron' }) {
  const procs = () => app.processes.all()
  const focus = typeof at === 'string' ? at : undefined
  const focused = focus ? app.processes.get(focus) : undefined
  let tab: Tab = focused ? (isRunning(focused) ? 'running' : 'all') : app.processes.running().length ? 'running' : 'all'

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
  const release = app.processes.watch()
  const releaseCron = app.cron.watch()

  // Ends with the sheet, however it closed (Esc, a session switch replacing the overlays).
  const timer = setInterval(() => (app.overlays.includes(overlay) ? app.changed() : end()), TICK_MS)

  function end() {
    clearInterval(timer)
    clearTimeout(copiedTimer)
    release()
    releaseCron()
  }

  const close = () => {
    end()
    app.close(overlay)
  }

  const shown = (): BackgroundProcess[] => (tab === 'running' ? procs().filter(isRunning) : procs())
  const current = () => procs().find(p => p.id === selected)

  const stopOne = async () => {
    const p = current()
    confirm = undefined

    if (!p || !isRunning(p)) {
      return app.changed()
    }

    try {
      const status = await app.processes.kill(p.id)

      if (status && status !== 'killed') {
        app.transcript.notice(`${describeCommand(p.command)}: ${status.replace(/_/g, ' ')}.`, 'warning')
      }
    } catch (error) {
      app.transcript.notice(error instanceof Error ? error.message : String(error), 'error')
    }

    app.changed()
  }

  const stopAll = async () => {
    confirm = undefined

    try {
      const n = await app.processes.stopAll()
      app.transcript.notice(`Stopped ${n} background process${n === 1 ? '' : 'es'}.`)
    } catch (error) {
      app.transcript.notice(error instanceof Error ? error.message : String(error), 'error')
    }

    app.changed()
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
      app.changed()
    }, COPIED_MS)
    app.changed()
  }

  const ask = (what: 'all' | 'one') => {
    const p = current()

    if (what === 'one' ? p && isRunning(p) && !app.processes.stopping(p.id) : app.processes.running().length) {
      confirm = what
    }
  }

  const currentJob = () => app.cron.jobs().find(j => j.job_id === job)

  const actJob = async (action: 'pause' | 'remove' | 'resume') => {
    const j = currentJob()
    confirm = undefined

    if (!j || app.cron.busy(j.job_id)) {
      return app.changed()
    }

    try {
      await app.cron.act(action, j.job_id)
    } catch (error) {
      app.transcript.notice(error instanceof Error ? error.message : String(error), 'error')
    }

    app.changed()
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
              app.cron.jobs().map(j => j.job_id),
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
      app.changed()
    },
    cancel: () => {
      confirm = undefined
      app.changed()
    },
    close: () => {
      if (expanded) {
        expanded = false
        app.changed()
      } else {
        close()
      }
    },
    confirm: settle,
    copy,
    expand: () => {
      expanded = Boolean(current()) && !expanded
      app.changed()
    },
    remove: () => {
      askRemove()
      app.changed()
    },
    stop: () => {
      ask('one')
      app.changed()
    },
    tab: (ev: { value?: string }) => {
      tab = TABS.find(t => t === ev.value) ?? 'all'
      expanded = false
      confirm = undefined
      app.changed()
    },
    toggle: toggleJob
  }

  function sheetNode(now: number): JSX.Element {
    return tab === 'cron' ? cronNode(now) : processNode(now)
  }

  const tabs = () => [
    { count: app.processes.running().length, id: 'running', label: 'Running' },
    { count: procs().length, id: 'all', label: 'All' },
    { count: app.cron.loaded ? app.cron.jobs().length : undefined, id: 'cron', label: 'Cron' }
  ]

  function cronNode(now: number): JSX.Element {
    const jobs = app.cron.jobs()
    const own = ownJobs(app.transcript.calls('cronjob_manage'))

    if (!jobs.some(j => j.job_id === job)) {
      job = jobs[0]?.job_id
    }

    const j = jobs.find(x => x.job_id === job)
    const busy = j ? app.cron.busy(j.job_id) : false
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
          app.cron.error
            ? `Could not list cron jobs: ${app.cron.error}`
            : app.cron.loaded
              ? 'No cron jobs. Ask Hermes to schedule one or to watch something.'
              : 'Loading cron jobs…'
        }
        icon="clock"
        items={jobs.map(x => jobItem(x, now, own.has(x.job_id), app.cron.busy(x.job_id)))}
        key={KEY}
        noun="jobs"
        onAction={handlers}
        onSelect={ev => {
          job = ev.item
          confirm = undefined
          app.changed()
        }}
        order={jobs.map(x => x.job_id)}
        preview="side"
        selected={job}
        size="lg"
        subtitle={[{ s: 'muted', t: app.cron.warning ?? cronSummary(jobs) }]}
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
    const call = p && callOf(app, p.id)
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
            disabled: p && isRunning(p) ? (app.processes.stopping(p.id) ? 'Stopping' : undefined) : 'Not running',
            id: 'stop',
            keys: ['k'],
            label: p && app.processes.stopping(p.id) ? 'Stopping…' : 'Stop'
          },
          { danger: true, disabled: running ? undefined : 'None running', id: 'all', keys: ['shift+k'], label: 'Stop all' },
          { end: true, id: 'close', keys: ['esc'], label: expanded ? 'Back' : 'Close' }
        ]}
        columns={columns}
        confirm={
          confirm === 'all'
            ? { act: 'confirm', label: 'Stop all', text: `Stop ${running} background process${running === 1 ? '' : 'es'}?` }
            : confirm === 'one' && p
              ? { act: 'confirm', label: 'Stop', text: `Stop ${describeCommand(p.command)}?` }
              : undefined
        }
        empty={tab === 'running' ? 'No background processes running. Tab shows the finished ones.' : 'No background processes in this session'}
        focus={expanded ? 'preview' : undefined}
        icon="terminal"
        items={all.map(x => item(x, now, app.processes.stopping(x.id)))}
        key={KEY}
        noun="processes"
        onAction={handlers}
        onActivate={ev => {
          selected = ev.item
          expanded = true
          app.changed()
        }}
        onSelect={ev => {
          selected = ev.item
          confirm = undefined
          app.changed()
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

  app.open(overlay)
}

function next(tab: Tab, back: boolean): Tab {
  return TABS[(TABS.indexOf(tab) + (back ? TABS.length - 1 : 1)) % TABS.length]!
}

function cronSummary(jobs: CronJob[]): string {
  const paused = jobs.filter(isPaused).length
  const monitors = jobs.filter(isMonitor).length
  const parts = [
    [jobs.length - paused, 'active'],
    [paused, 'paused'],
    [monitors, monitors === 1 ? 'monitor' : 'monitors']
  ] as const

  return parts.filter(([n]) => n).map(([n, label]) => `${n} ${label}`).join(' · ') || 'none yet'
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
  const at = (iso: string | null | undefined) => (iso ? `${clock(Date.parse(iso))} · ${relative(iso, now)}` : '—')
  const error = jobError(j)
  const fact = (k: string, v: string | null | undefined) => (v ? [{ k: [{ t: k }], v }] : [])

  return [
    <text key="title" role="omp.hub.title" text={j.name || j.job_id} />,
    <kv
      items={[
        { k: [{ t: 'State' }], v: [{ s: jobTone(j), t: isPaused(j) ? `Paused${j.paused_reason ? ` · ${j.paused_reason}` : ''}` : 'Active' }] },
        ...fact('Schedule', j.schedule),
        ...(isPaused(j) ? [] : fact('Next run', at(j.next_run_at))),
        { k: [{ t: 'Last run' }], v: j.last_run_at ? `${at(j.last_run_at)}${j.last_status ? ` · ${j.last_status}` : ''}` : 'never' },
        ...fact('Repeat', j.repeat === null || j.repeat === undefined ? undefined : String(j.repeat)),
        ...fact('Delivers to', j.deliver),
        ...fact('Watches', j.monitor_url ?? j.monitor_script),
        ...fact('Script', j.script),
        ...fact('Folder', j.workdir),
        ...fact('Model', j.model),
        ...fact('Skills', j.skills?.join(' · ')),
        ...(own ? [{ k: [{ t: 'Made by' }], v: 'this session' }] : []),
        { k: [{ t: 'Job' }], v: [{ s: 'mono dim', t: j.job_id }] }
      ]}
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
function callOf(app: App, id: string): ToolCall | undefined {
  return app.transcript.backgroundCalls().find(c => isBackgroundCall(c) && (processIdOf(c) ?? c.process?.id) === id)
}

function summary(all: BackgroundProcess[]): string {
  const count = (s: BackgroundProcess['status']) => all.filter(p => p.status === s).length
  const parts = [
    [count('running'), 'running'],
    [count('done'), 'exited'],
    [count('failed'), 'failed'],
    [count('killed') + count('lost'), 'stopped']
  ] as const

  return parts.filter(([n]) => n).map(([n, label]) => `${n} ${label}`).join(' · ') || 'none yet'
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
      items={[
        { k: [{ t: 'Status' }], v: [{ s: processTone(p.status), t: isRunning(p) ? STATUS.running : `${STATUS[p.status]} · ${processVerdict(p)}` }] },
        { k: [{ t: 'Started' }], v: clock(p.startedAt) },
        { k: [{ t: isRunning(p) ? 'Running for' : 'Ran for' }], v: duration(processElapsed(p, now)) },
        ...(p.exitedAt ? [{ k: [{ t: 'Exited' }], v: `${clock(p.exitedAt)} · ${duration(now - p.exitedAt)} ago` }] : []),
        ...(p.reason && p.status !== 'running' ? [{ k: [{ t: 'Reason' }], v: p.reason.replace(/_/g, ' ') }] : []),
        ...(w ? watcherFacts(w) : []),
        { k: [{ t: 'Process' }], v: [{ s: 'mono dim', t: p.id }] }
      ]}
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

function watcherFacts(w: Watchers): { k: { t: string }[]; v: string }[] {
  return [
    { k: [{ t: 'Notify' }], v: w.notify ? 'when it exits' : w.patterns.length ? 'on a matching line' : 'off' },
    ...(w.patterns.length ? [{ k: [{ t: 'Watch' }], v: w.patterns.join(' · ') }] : []),
    ...(w.heartbeat ? [{ k: [{ t: 'Heartbeat' }], v: `every ${w.heartbeat}s` }] : [])
  ]
}

/** `14:02:07`: a wall-clock time today. */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', hour12: false, minute: '2-digit', second: '2-digit' })
}
