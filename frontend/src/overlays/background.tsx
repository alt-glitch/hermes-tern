// The Background sheet (`/ps`, ⌥B, the shells pill, a background terminal card): the session's
// background processes in one `picker`, as Claude Code lists its background shells. Each row is
// the command's readable title with the command dim, its status, its run time and its last
// output line; the preview shows the process's facts and its output, following the end. Enter
// gives the output the whole sheet, K stops the selected process, Shift+K stops them all (both
// ask first), C copies the command.

import type { JSX, Key, PickerColumn, PickerItem } from '@stencil-hq/tern'

import type { App } from '../app.js'
import { copyToClipboard } from '../clipboard.js'
import type { BackgroundProcess, ToolCall } from '../model.js'
import type { Overlay } from '../overlay.js'
import {
  isRunning,
  processElapsed,
  processIdOf,
  processTone,
  processVerdict,
  watchersOf,
  type Watchers
} from '../processes/store.js'
import { commandLine, describeCommand } from '../view/describe.js'
import { duration } from '../view/time.js'

import { moveSelection } from './search.js'

const KEY = 'background'
/** Run times follow the clock while the sheet is open. */
const TICK_MS = 1000
const COPIED_MS = 1500

type Tab = 'running' | 'all'

const STATUS: Record<BackgroundProcess['status'], string> = {
  done: 'Exited',
  failed: 'Failed',
  killed: 'Stopped',
  lost: 'Lost',
  running: 'Running'
}

/** Opens the sheet, on process `focus` when given. */
export function openBackground(app: App, focus?: string) {
  const procs = () => app.processes.all()
  const focused = focus ? app.processes.get(focus) : undefined
  let tab: Tab = focused ? (isRunning(focused) ? 'running' : 'all') : app.processes.running().length ? 'running' : 'all'
  let selected = focus ?? procs().find(isRunning)?.id ?? procs()[0]?.id
  /** Enter: the output takes the whole sheet. */
  let expanded = false
  let confirm: 'all' | 'one' | undefined
  let copied: string | undefined
  let copiedTimer: NodeJS.Timeout | undefined
  const release = app.processes.watch()

  // Ends with the sheet, however it closed (Esc, a session switch replacing the overlays).
  const timer = setInterval(() => (app.overlays.includes(overlay) ? app.changed() : end()), TICK_MS)

  function end() {
    clearInterval(timer)
    clearTimeout(copiedTimer)
    release()
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

  const overlay: Overlay = {
    key: KEY,
    modal: true,
    node: () => sheetNode(Date.now()),
    onKey: (k: Key) => {
      if (confirm) {
        if (k.name === 'enter' || k.name === 'y') {
          void (confirm === 'all' ? stopAll() : stopOne())
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
      } else if (k.name === 'enter') {
        expanded = Boolean(current()) && !expanded
      } else if (k.name === 'k' && bare) {
        ask(k.shift ? 'all' : 'one')
      } else if (k.name === 'c' && bare && !k.shift) {
        copy()
      } else if (k.name === 'tab' && !expanded) {
        tab = tab === 'running' ? 'all' : 'running'
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
    confirm: () => void (confirm === 'all' ? stopAll() : stopOne()),
    copy,
    expand: () => {
      expanded = Boolean(current()) && !expanded
      app.changed()
    },
    stop: () => {
      ask('one')
      app.changed()
    },
    tab: (ev: { value?: string }) => {
      tab = ev.value === 'running' ? 'running' : 'all'
      app.changed()
    }
  }

  function sheetNode(now: number): JSX.Element {
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
        tabs={[
          { count: running, id: 'running', label: 'Running' },
          { count: all.length, id: 'all', label: 'All' }
        ]}
        title="Background"
        total={all.length}
      >
        {p ? (expanded ? outputView(p, now) : preview(p, call, now)) : null}
      </picker>
    )
  }

  app.open(overlay)
}

/** The terminal call that started process `id`, for its watchers. */
function callOf(app: App, id: string): ToolCall | undefined {
  return app.transcript.backgroundCalls().find(c => (processIdOf(c) ?? c.process?.id) === id)
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
