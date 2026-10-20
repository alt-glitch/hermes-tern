// The session's background processes (`terminal(background=true)`), for the shells pill, the
// Background sheet and the live line on each background terminal card. Output arrives as it is
// printed (`agent.terminal.output`); status and exits come from polling `process.list`
// (session-scoped): every second while the sheet is open or a process runs, else every five. Exited processes stay on the pill for
// Hermes' 60 s (ui-tui/src/app/processRoster.ts); the sheet's All tab keeps whatever the
// gateway still lists.

import type { GatewayClient } from '@tui/gatewayClient.js'

import type { LiveSessionId } from '../core/ids.js'
import type { BackgroundProcess, ToolCall } from '../model.js'
import type { Transcript } from '../transcript.js'
import { isWatchCall } from '../transcript/calls.js'
import { withoutTernEnv } from '../view/describe.js'
import { record } from '../wire/json.js'
import { rpc, rpcParsed } from '../wire/rpc.js'
import { processList, type ProcessRow } from '../wire/schemas.js'

import { Charts, type ChartsOptions } from './widgets/registry.js'

/** What the store reaches of the app. */
export interface ProcessesHost {
  readonly gw: Pick<GatewayClient, 'request'>
  /** The open session's runtime id. */
  readonly sid: LiveSessionId | null
  readonly transcript: Transcript
  changed(): void
}

/** How much output a process keeps between polls: the shared gateway's `output_tail` is 32k. */
export const OUTPUT_MAX = 32_000

/** How long an exited process stays on the pill (Hermes' PROCESS_RETAIN_SECONDS). */
export const RETAIN_MS = 60_000
export const FAST_MS = 1000
export const IDLE_MS = 5000

const REASON_STATUS: Record<string, BackgroundProcess['status']> = { failed_start: 'failed', killed: 'killed', lost: 'lost' }

/** Hermes' mapping: running until exited, then the completion reason, else the exit code. */
export function processStatus(entry: Pick<ProcessRow, 'completion_reason' | 'exit_code' | 'status'>): BackgroundProcess['status'] {
  if (entry.status !== 'exited') {
    return 'running'
  }

  return REASON_STATUS[entry.completion_reason ?? ''] ?? (entry.exit_code ? 'failed' : 'done')
}

// eslint-disable-next-line no-control-regex -- terminal escapes are what this strips
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g

/** The last non-empty line of `output`, without escapes; a `\r`-redrawn line reads as its newest draw. */
export function lastLine(output: string): string {
  const lines = output.replace(ESCAPES, '').split('\n')

  for (let i = lines.length - 1; i >= 0; i--) {
    const draws = lines[i]!.split('\r')
    const text = (draws.findLast(d => d.trim()) ?? '').replace(/\s+/g, ' ').trim()

    if (text) {
      return text
    }
  }

  return ''
}

/** `entry` folded into `prev` (kept as the same object, so Tern timers keyed on it stay put). */
export function foldEntry(prev: BackgroundProcess | undefined, entry: ProcessRow, now: number): BackgroundProcess {
  const status = processStatus(entry)
  const output = entry.output_tail ?? entry.output_preview ?? prev?.output ?? ''
  const startedAt =
    typeof entry.started_epoch === 'number'
      ? entry.started_epoch * 1000
      : (prev?.startedAt ?? now - Math.max(0, entry.uptime_seconds ?? 0) * 1000)

  const p: BackgroundProcess = prev ?? { command: '', id: entry.session_id, lastLine: '', output: '', startedAt, status }

  p.command = withoutTernEnv((entry.command ?? '').trim()) || p.command || 'background process'
  p.status = status
  p.startedAt = startedAt
  p.output = output
  p.lastLine = lastLine(output)
  p.exitCode = typeof entry.exit_code === 'number' && status !== 'running' ? entry.exit_code : undefined
  p.reason = status !== 'running' ? (entry.completion_reason ?? undefined) : undefined
  p.exitedAt = status === 'running' ? undefined : typeof entry.exited_at === 'number' && entry.exited_at ? entry.exited_at * 1000 : p.exitedAt

  return p
}

export function isRunning(p: BackgroundProcess): boolean {
  return p.status === 'running'
}

/** Still on the pill: running, or exited within the retention window (an exit with no time is not). */
export function isRecent(p: BackgroundProcess, now: number): boolean {
  return isRunning(p) || (p.exitedAt !== undefined && now - p.exitedAt <= RETAIN_MS)
}

/** Running first, longest-running first; then exited ones, newest exit first. */
export function sortProcesses(list: readonly BackgroundProcess[]): BackgroundProcess[] {
  return [...list].sort((a, b) =>
    isRunning(a) !== isRunning(b)
      ? isRunning(a)
        ? -1
        : 1
      : isRunning(a)
        ? a.startedAt - b.startedAt
        : (b.exitedAt ?? 0) - (a.exitedAt ?? 0)
  )
}

/** How long it ran (so far, while running). */
export function processElapsed(p: BackgroundProcess, now: number): number {
  return Math.max(0, (p.exitedAt ?? (isRunning(p) ? now : p.startedAt)) - p.startedAt)
}

const TONE: Record<BackgroundProcess['status'], 'accent' | 'error' | 'success' | 'warning'> = {
  done: 'success',
  failed: 'error',
  killed: 'warning',
  lost: 'warning',
  running: 'accent'
}

/** The status's palette tone: accent while running, then success, error or warning. */
export function processTone(status: BackgroundProcess['status']): 'accent' | 'error' | 'success' | 'warning' {
  return TONE[status]
}

/** `running`, `exit 0`, `exit 2`, `killed`, `lost`, `failed to start`. */
export function processVerdict(p: BackgroundProcess): string {
  switch (p.status) {
    case 'running':
      return 'running'

    case 'killed':

    case 'lost':
      return p.status

    default:
      return p.reason === 'failed_start' ? 'failed to start' : `exit ${p.exitCode ?? '?'}`
  }
}

/** How a background process reports back to the agent. */
export interface Watchers {
  /** One notification when it exits (`notify: true`, `notify_on_complete`). */
  notify: boolean
  /** Output patterns that notify when a line matches (`notify: [...]`, `watch_patterns`). */
  patterns: string[]
  /** Seconds between "still running" notices; 0 is off. */
  heartbeat: number
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [])

/**
 * A background call's watchers. The start result says what Hermes armed (it drops patterns next
 * to notify-on-exit, clamps heartbeats, disarms both in a subagent); until it arrives, the
 * arguments as tools/terminal_tool.py `_handle_terminal` reads them.
 */
export function watchersOf(call: Pick<ToolCall, 'args' | 'result'>): Watchers {
  const r = record(call.result)

  if (typeof r?.session_id === 'string') {
    return {
      heartbeat: typeof r.heartbeat_seconds === 'number' ? r.heartbeat_seconds : 0,
      notify: r.notify_on_complete === true,
      patterns: strings(r.watch_patterns)
    }
  }

  const a = call.args
  const beat = typeof a.heartbeat === 'number' && a.heartbeat > 0 ? Math.max(60, Math.floor(a.heartbeat)) : 0
  let notify = a.notify_on_complete === true
  let patterns = strings(a.watch_patterns)

  // `notify` is the advertised flag and wins over the legacy pair.
  if (typeof a.notify === 'boolean') {
    notify = a.notify
    patterns = []
  } else if (Array.isArray(a.notify)) {
    notify = false
    patterns = strings(a.notify)
  }

  notify ||= beat > 0

  return { heartbeat: beat, notify, patterns: notify ? [] : patterns }
}

/** The process id a background terminal call's result names. */
export function processIdOf(call: ToolCall): string | undefined {
  const id = record(call.result)?.session_id

  return typeof id === 'string' && id ? id : undefined
}

export class Processes {
  readonly #host: ProcessesHost
  readonly #byId = new Map<string, BackgroundProcess>()
  #sid: LiveSessionId | null = null
  #timer: NodeJS.Timeout | undefined
  #ticking = false
  #again = false
  /** Open sheets wanting the fast cadence. */
  #watchers = 0
  /** The pill's rows at the last tick, to re-render when one ages out. */
  #shown = ''
  #disposed = false
  /** Ids a stop was sent for and that still run: the registry can take seconds to end one. */
  readonly #stopping = new Set<string>()
  /** Each process's live chart, kept on `p.chart`. */
  readonly #charts: Charts

  constructor(host: ProcessesHost, charts: ChartsOptions = {}) {
    this.#host = host
    // A spec arrived: every chart may have changed.
    this.#charts = new Charts(() => this.#chart([...this.#byId.values()]) && this.#host.changed(), charts)
  }

  /** Everything the gateway still lists for the session, in roster order. */
  all(): BackgroundProcess[] {
    return sortProcesses([...this.#byId.values()])
  }

  running(): BackgroundProcess[] {
    return this.all().filter(isRunning)
  }

  /** The pill's rows: running ones and those that exited within the last minute. */
  recent(now = Date.now()): BackgroundProcess[] {
    return this.all().filter(p => isRecent(p, now))
  }

  get(id: string): BackgroundProcess | undefined {
    return this.#byId.get(id)
  }

  /** A stop was sent for `id` and it has not ended yet. */
  stopping(id: string): boolean {
    const p = this.#byId.get(id)

    return this.#stopping.has(id) && Boolean(p && isRunning(p))
  }

  /** Polls now (a background command just started, the sheet opened, a stop landed). */
  poke() {
    clearTimeout(this.#timer)
    this.#timer = undefined
    void this.#tick()
  }

  /** The fast cadence while the returned release has not run (an open sheet). */
  watch(): () => void {
    this.#watchers++
    this.poke()
    let released = false

    return () => {
      if (!released) {
        released = true
        this.#watchers--
      }
    }
  }

  /** A chunk `id` printed (`agent.terminal.output`); a process the store does not know yet polls. */
  output(id: string, chunk: string) {
    const p = this.#byId.get(id)

    if (!p) {
      return this.poke()
    }

    p.output = (p.output + chunk).slice(-OUTPUT_MAX)
    p.lastLine = lastLine(p.output)
    this.#charts.output(id, chunk)
    this.#chart([p])
    this.#link(new Set([p]))
    this.#host.changed()
  }

  /** Stops one process (`process.kill`); the registry's answer status (`killed`, `already_exited`, …). */
  async kill(id: string): Promise<string | undefined> {
    this.#stopping.add(id)
    this.#host.changed()

    try {
      const sid = this.#host.sid
      const r = sid ? await rpc(this.#host.gw, 'process.kill', { process_id: id, session_id: sid }) : undefined

      return r?.status
    } finally {
      this.#stopping.delete(id)
      this.poke()
    }
  }

  /** Stops every process of the session (`process.stop`); how many it stopped. */
  async stopAll(): Promise<number> {
    const ids = this.running().map(p => p.id)
    ids.forEach(id => this.#stopping.add(id))
    this.#host.changed()

    try {
      const r = await rpc(this.#host.gw, 'process.stop', { session_id: this.#host.sid })

      return typeof r?.killed === 'number' ? r.killed : 0
    } finally {
      ids.forEach(id => this.#stopping.delete(id))
      this.poke()
    }
  }

  dispose() {
    this.#disposed = true
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#charts.dispose()
  }

  /** Brings the charts of `procs` up to date and relinks the cards of those that changed; true when one did. */
  #chart(procs: readonly BackgroundProcess[]): boolean {
    const touched = new Set<BackgroundProcess>()

    for (const p of procs) {
      const chart = this.#charts.view(p)

      if (chart !== p.chart) {
        p.chart = chart
        touched.add(p)
      }
    }

    return this.#link(touched) || touched.size > 0
  }

  #schedule() {
    if (this.#disposed) {
      return
    }

    clearTimeout(this.#timer)
    const fast = this.#watchers > 0 || [...this.#byId.values()].some(isRunning)
    this.#timer = setTimeout(() => void this.#tick(), fast ? FAST_MS : IDLE_MS)
  }

  async #tick() {
    if (this.#ticking) {
      // A poke during a poll: poll once more right after it.
      this.#again = true

      return
    }

    this.#ticking = true

    try {
      do {
        this.#again = false
        await this.#poll()
      } while (this.#again)
    } finally {
      this.#ticking = false
      this.#schedule()
    }
  }

  async #poll() {
    const sid = this.#host.sid
    let changed = false

    if (sid !== this.#sid) {
      // Another session: its processes are not this one's.
      changed = this.#byId.size > 0
      this.#byId.clear()
      this.#sid = sid
    }

    if (!sid) {
      return changed ? this.#host.changed() : undefined
    }

    let rows: ProcessRow[]

    try {
      rows = await rpcParsed(this.#host.gw, 'process.list', { session_id: sid }, processList)
    } catch {
      // A gateway without process.list, or a session it no longer holds live.
      return changed ? this.#host.changed() : undefined
    }

    if (sid !== this.#host.sid) {
      return
    }

    const now = Date.now()
    const touched = new Set<BackgroundProcess>()
    const listed = new Set<string>()

    for (const row of rows) {
      if (!row.session_id) {
        continue
      }

      listed.add(row.session_id)
      const prev = this.#byId.get(row.session_id)
      const before = prev && snapshot(prev)
      const p = foldEntry(prev, row, now)
      this.#byId.set(p.id, p)

      if (snapshot(p) !== before) {
        touched.add(p)
      }
    }

    for (const p of [...this.#byId.values()]) {
      if (listed.has(p.id)) {
        continue
      }

      if (isRunning(p)) {
        // Gone from the registry while running (a restarted gateway): Hermes calls that lost.
        p.status = 'lost'
        p.exitedAt = now
        touched.add(p)
      } else if (!isRecent(p, now)) {
        this.#byId.delete(p.id)
        changed = true
      }
    }

    this.#charts.retain(new Set(this.#byId.keys()))
    changed = this.#chart([...this.#byId.values()]) || changed
    changed = this.#link(touched) || touched.size > 0 || changed
    const shown = this.recent(now)
      .map(p => `${p.id}:${p.status}`)
      .join()

    if (shown !== this.#shown) {
      this.#shown = shown
      changed = true
    }

    if (changed) {
      this.#host.changed()
    }
  }

  /** Points each background terminal card at its process; true when a card changed. */
  #link(touched: Set<BackgroundProcess>): boolean {
    const calls = this.#host.transcript.backgroundCalls()
    const owners = linkCalls(calls, [...this.#byId.values()])
    let changed = false

    for (const call of calls) {
      const p = owners.get(call)

      if (p && (call.process !== p || touched.has(p))) {
        this.#host.transcript.mutateCall(call, c => (c.process = p))
        changed = true
      }
    }

    return changed
  }
}

/**
 * Each background call's process: by the id its start result names, else (a resumed session,
 * whose history drops terminal results) the oldest unclaimed process running the same command.
 * The shared gateway cuts commands at 200 characters, so a prefix matches.
 */
export function linkCalls(calls: readonly ToolCall[], procs: readonly BackgroundProcess[]): Map<ToolCall, BackgroundProcess> {
  const byId = new Map(procs.map(p => [p.id, p]))
  const owners = new Map<ToolCall, BackgroundProcess>()
  const claimed = new Set<string>()

  for (const call of calls) {
    const p = call.name === 'terminal' ? byId.get(processIdOf(call) ?? '') : undefined

    if (p) {
      owners.set(call, p)
      claimed.add(p.id)
    }
  }

  // A process tool call names its process by id or a unique prefix of it; many calls may watch one.
  for (const call of calls) {
    const ref = isWatchCall(call) ? String(call.args.session_id).trim() : ''
    const matches = ref ? procs.filter(p => p.id.startsWith(ref)) : []

    if (matches.length === 1) {
      owners.set(call, matches[0]!)
    }
  }

  const free = [...procs].sort((a, b) => a.startedAt - b.startedAt)

  for (const call of calls) {
    const command = typeof call.args.command === 'string' ? call.args.command.trim() : ''

    if (owners.has(call) || processIdOf(call) || !command || call.name !== 'terminal') {
      continue
    }

    const p = free.find(x => !claimed.has(x.id) && x.command && command.startsWith(x.command))

    if (p) {
      owners.set(call, p)
      claimed.add(p.id)
    }
  }

  return owners
}

function snapshot(p: BackgroundProcess): string {
  return `${p.status}|${p.exitCode}|${p.exitedAt}|${p.startedAt}|${p.output.slice(-120)}|${p.lastLine}|${p.command}`
}
