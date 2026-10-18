// The session's standing /goal and /loop, for the dock line above the composer and its sheet.
// `session.control.read` seeds the snapshot when a session is adopted and `session.control.update`
// replaces it on every set, pause, resume, stop, wakeup and judged turn (gateway/
// session_control_actions.py `publish`), so `next_due_at` is always the live anchor. The reading
// of the snapshot follows Ink's ui-tui/src/app/goalStatus.ts and loopStatus.ts; the buttons send
// the `session.control` verbs desktop's status stack sends.

import type { GoalSnapshot, LoopSnapshot, SessionControlSnapshot } from '@hermes/shared/gateway-events'
import type { GatewayClient } from '@tui/gatewayClient.js'

import type { NoticeEntry } from './model.js'

/** What the store reaches of the app. */
export interface AutomationHost {
  readonly gw: Pick<GatewayClient, 'request'>
  readonly sid: string | null
  readonly transcript: { notice(text: string, tone?: NoticeEntry['tone']): void }
  changed(): void
  /** Acts on a command's dispatch envelope, as a typed command's (a goal resume sends its kickoff). */
  runDispatch(raw: unknown, title: string): Promise<void>
}

/** The verbs `session.control` takes for the goal and the loop. */
export type AutomationAction = 'goal.clear' | 'goal.pause' | 'goal.resume' | 'goal.unwait' | 'loop.pause' | 'loop.resume' | 'loop.stop'

export type GoalState = 'active' | 'blocked' | 'paused' | 'waiting'

/** A standing goal as the dock and the sheet show it. */
export interface GoalView {
  state: GoalState
  title: string
  turns: number
  /** The turn budget; 0 is none. */
  maxTurns: number
  /** Why it is held: the wait (`until 14:30`, `on session x`) or the pause reason. */
  detail: string
  /** The judge's last verdict (`continue`, `blocked`, `wait`, …) and its reason. */
  verdict?: string
  reason?: string
  criteria: string[]
}

export type LoopState = 'active' | 'deferred' | 'due' | 'paused' | 'running'

/** A standing loop as the dock and the sheet show it. */
export interface LoopView {
  state: LoopState
  prompt: string
  /** `every 45m` or `self-paced`. */
  cadence: string
  /** `2 runs`, `2/5 runs`. */
  runs: string
  fired: number
  /** The run limit; 0 is none. */
  times: number
  /** When the next run is due (ms since the epoch); only while it counts down. */
  dueAt?: number
  until: string
  detail: string
}

/** Rounded up: whole minutes (`1h05m`, `44m`) until the last minute, then seconds (Ink's countdown). */
export function countdown(seconds: number): string {
  const left = Math.max(0, Math.ceil(seconds))

  if (left < 60) {
    return `${left}s`
  }

  const minutes = Math.ceil(left / 60)
  const hours = Math.floor(minutes / 60)

  return hours ? `${hours}h${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`
}

/** `every 45m`, `every 2h`, `self-paced`. */
export function cadence(loop: Pick<LoopSnapshot, 'interval_seconds' | 'mode'>): string {
  if (loop.mode === 'self_paced') {
    return 'self-paced'
  }

  const s = loop.interval_seconds

  return `every ${s % 3600 === 0 ? `${s / 3600}h` : s % 60 === 0 ? `${s / 60}m` : `${s}s`}`
}

const clock = (epochSeconds: number) =>
  new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** The goal while it stands (active or paused); null once it is done or cleared (the transcript has the verdict). */
export function goalView(goal: GoalSnapshot | null | undefined): GoalView | null {
  if (!goal || (goal.status !== 'active' && goal.status !== 'paused')) {
    return null
  }

  const barrier = goal.status === 'active' ? goal.wait_barrier : null

  const wait = barrier
    ? [barrier.type === 'until' ? `until ${clock(barrier.until_at)}` : `on ${barrier.type} ${barrier.target}`, barrier.reason]
        .filter(Boolean)
        .join(' · ')
    : ''

  return {
    criteria: goal.subgoals ?? [],
    detail: barrier ? wait : goal.status === 'paused' ? (goal.paused_reason ?? '') : '',
    maxTurns: goal.max_turns,
    reason: goal.last_reason ?? undefined,
    state: goal.status === 'paused' ? 'paused' : barrier ? 'waiting' : goal.last_verdict === 'blocked' ? 'blocked' : 'active',
    title: goal.title,
    turns: goal.turns_used,
    verdict: goal.last_verdict ?? undefined
  }
}

/** The loop while it stands (active or paused); null once it is done or stopped. */
export function loopView(loop: LoopSnapshot | null | undefined, now = Date.now()): LoopView | null {
  if (!loop || (loop.status !== 'active' && loop.status !== 'paused')) {
    return null
  }

  const dueAt = loop.next_due_at > 0 ? loop.next_due_at * 1000 : undefined

  const state: LoopState =
    loop.status === 'paused'
      ? 'paused'
      : loop.awaiting_response
        ? 'running'
        : loop.deferred_by_goal
          ? 'deferred'
          : dueAt !== undefined && dueAt > now
            ? 'active'
            : 'due'

  return {
    cadence: cadence(loop),
    detail: loop.status === 'paused' ? (loop.paused_reason ?? '') : '',
    dueAt: state === 'active' ? dueAt : undefined,
    fired: loop.ticks_fired,
    prompt: loop.prompt,
    runs: loop.times ? `${loop.ticks_fired}/${loop.times} runs` : `${loop.ticks_fired} run${loop.ticks_fired === 1 ? '' : 's'}`,
    state,
    times: loop.times,
    until: loop.until ?? ''
  }
}

/** What a button's verb is called, for its failure line. */
const ACTION_LABELS: Record<AutomationAction, string> = {
  'goal.clear': 'clear the goal',
  'goal.pause': 'pause the goal',
  'goal.resume': 'resume the goal',
  'goal.unwait': 'stop the goal waiting',
  'loop.pause': 'pause the loop',
  'loop.resume': 'resume the loop',
  'loop.stop': 'stop the loop'
}

/** The open session's control snapshot, and the verbs that change it. */
export class Automation {
  readonly #host: AutomationHost
  #sid: string | null = null
  #snapshot: SessionControlSnapshot | null = null
  /** Bumped by every update, so a read that started before one never overwrites it. */
  #seq = 0
  #timer: NodeJS.Timeout | undefined
  /** The verb in flight, if any (the sheet's buttons wait for it). */
  pending: AutomationAction | undefined

  constructor(host: AutomationHost) {
    this.#host = host
  }

  get goal(): GoalView | null {
    return goalView(this.#snapshot?.goal)
  }

  loop(now = Date.now()): LoopView | null {
    return loopView(this.#snapshot?.loop, now)
  }

  /** The loop's raw snapshot: a new object per update, so its countdown re-anchors only then. */
  get loopSnapshot(): LoopSnapshot | null {
    return this.#snapshot?.loop ?? null
  }

  /** Another session is shown: forget the last one's state and read this one's. */
  adopt(sid: string) {
    this.#sid = sid
    this.#set(null)
    void this.#read(sid)
  }

  /** A `session.control.update` (or a verb's reply) for session `sid`. */
  apply(sid: string | null | undefined, control: SessionControlSnapshot | null | undefined) {
    if (sid && sid !== this.#sid) {
      return
    }

    this.#seq++
    this.#set(control ?? null)
  }

  async #read(sid: string) {
    const seq = this.#seq

    try {
      const r = await this.#host.gw.request<{ control?: SessionControlSnapshot }>('session.control.read', { session_id: sid })

      if (sid === this.#sid && seq === this.#seq) {
        this.#set(r?.control ?? null)
      }
    } catch {
      // A gateway without session controls: no goal or loop to show.
    }
  }

  /** Runs `action` on the open session; the reply's snapshot repaints, its dispatch runs as a typed command's. */
  async act(action: AutomationAction) {
    const sid = this.#sid

    if (!sid || this.pending) {
      return
    }

    this.pending = action
    this.#host.changed()

    try {
      const r = await this.#host.gw.request<{ control?: SessionControlSnapshot; dispatch?: Record<string, unknown> }>(
        'session.control',
        { action, session_id: sid }
      )

      this.apply(sid, r?.control)

      if (r?.dispatch?.type && sid === this.#host.sid) {
        await this.#host.runDispatch(r.dispatch, `/${action.replace('.', ' ')}`)
      }
    } catch (error) {
      this.#host.transcript.notice(
        `Could not ${ACTION_LABELS[action]}: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      )
    } finally {
      this.pending = undefined
      this.#host.changed()
    }
  }

  #set(control: SessionControlSnapshot | null) {
    if (JSON.stringify(control) !== JSON.stringify(this.#snapshot)) {
      this.#snapshot = control
      this.#host.changed()
    }

    this.#arm()
  }

  /** Re-renders when the loop falls due, so its countdown turns into "due". Tern ticks the countdown itself. */
  #arm() {
    clearTimeout(this.#timer)
    const due = this.loop()?.dueAt

    if (due !== undefined) {
      this.#timer = setTimeout(() => this.#host.changed(), Math.max(0, due - Date.now()) + 50)
      this.#timer.unref?.()
    }
  }
}
