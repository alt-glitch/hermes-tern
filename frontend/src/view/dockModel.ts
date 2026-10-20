// The dock's view model: what dockNodes() draws, read from the stores once per frame. dockModel()
// only reads (a frame runs its side effects before it, in app/frame.ts), and none of what it
// returns is a handler: the dock's actions are bound once, beside the stores (app/actions.ts).

import type { Usage } from '@hermes/shared/gateway-events'
import type { SessionInfo } from '@tui/types.js'

import type { Agents } from '../agents/store.js'
import type { Automation } from '../automation.js'
import { type Hud, type Pill, pills, todos } from '../chrome/hud.js'
import type { NoticeStrip } from '../chrome/notices.js'
import type { Reconnect } from '../chrome/reconnect.js'
import type { Composer } from '../composer.js'
import type { SessionIds } from '../core/ids.js'
import type { Attachments } from '../draft/attachments.js'
import { fastTier } from '../fast.js'
import type { PullRequests } from '../github/store.js'
import type { Todo } from '../model.js'
import { capsOf } from '../modelCaps.js'
import type { Overlay } from '../overlay.js'
import type { Completion } from '../overlays/completion.js'
import { prsPill } from '../overlays/pullRequests.js'
import { isRunning, type Processes, processTone } from '../processes/store.js'
import type { SessionTitle } from '../session/title.js'
import type { Transcript } from '../transcript.js'
import type { Activity } from '../turn/activity.js'
import type { PromptQueue } from '../turn/queue.js'

import type { DockActivity, DockContext, ShellsPill } from './dock.js'

/** The composer's placeholder. */
export const PLACEHOLDER = 'Ask Hermes — / commands · @ files'

/** What the dock reads, each part a narrow view of the store that owns it. */
export interface DockSources {
  readonly session: { readonly ref: Pick<SessionIds, 'live'>; readonly info: SessionInfo | null; readonly usage: Usage | null }
  readonly activity: Pick<Activity, 'busy' | 'compacting'>
  readonly composer: Composer
  readonly completion: Pick<Completion, 'ghost'>
  /** The open overlays, bottom first: a modal one on top takes the keys and the completion. */
  readonly overlays: readonly Pick<Overlay, 'modal'>[]
  readonly attachments: Pick<Attachments, 'chips'>
  readonly automation: Pick<Automation, 'goal' | 'loop' | 'loopSnapshot'>
  readonly reconnect: Pick<Reconnect, 'redial'>
  readonly hud: Pick<Hud, 'focused' | 'todosOpen'>
  readonly transcript: Pick<Transcript, 'currentTodos'>
  readonly agents: Pick<Agents, 'running'>
  readonly processes: Pick<Processes, 'recent'>
  readonly prs: Pick<PullRequests, 'entries'>
  readonly notices: Pick<NoticeStrip, 'current'>
  readonly title: Pick<SessionTitle, 'text'>
  readonly queue: Pick<PromptQueue, 'rows'>
}

/** What the pills are counted from. */
export type PillReads = Pick<DockSources, 'activity' | 'agents' | 'automation' | 'processes' | 'prs' | 'transcript'>

const IDLE: DockActivity = { kind: 'idle' }

/** A modal sheet is on top: it holds the keys, so the composer shows no completion and no pill focus. */
export function isModal(overlays: readonly Pick<Overlay, 'modal'>[]): boolean {
  return overlays.at(-1)?.modal === true
}

/** The agent's todo list while it matters: a turn runs, or something on it is still open. */
export function shownTodos(src: Pick<DockSources, 'activity' | 'transcript'>): Todo[] | undefined {
  return todos(src.transcript.currentTodos(), Boolean(src.activity.busy))
}

/** The pills above the composer at `now`, left to right: what the pill keys move over. */
export function shownPills(src: PillReads, now: number): Pill[] {
  return pills({
    agents: src.agents.running().length,
    busy: Boolean(src.activity.busy),
    goal: Boolean(src.automation.goal),
    loop: Boolean(src.automation.loop(now)),
    prs: src.prs.entries().length,
    shells: src.processes.recent(now).length,
    todos: shownTodos(src)
  })
}

/** What holds the session: the turn first; a compaction shows only with no turn. */
export function dockActivity(a: DockSources['activity']): DockActivity {
  const { busy, compacting } = a

  if (busy) {
    return { kind: 'turn', label: busy.label, since: busy.since, startedAt: busy.startedAt }
  }

  return compacting ? { kind: 'compacting', since: compacting.since, startedAt: compacting.startedAt } : IDLE
}

/** The dock at `now`, from what the stores hold. */
export function dockModel(src: DockSources, now: number): DockContext {
  const { info, usage } = src.session
  const modal = isModal(src.overlays)
  const used = usage?.context_used ?? 0
  const max = usage?.context_max ?? 0
  const list = shownTodos(src)

  return {
    activity: dockActivity(src.activity),
    composer: {
      attachments: src.attachments.chips(),
      draft: src.composer,
      ghost: modal ? '' : src.completion.ghost,
      placeholder: PLACEHOLDER,
      ready: src.session.ref.live !== null
    },
    now,
    pills: {
      agents: src.agents.running().length,
      automation: { goal: src.automation.goal, loop: src.automation.loop(now), loopOwner: src.automation.loopSnapshot },
      focused: modal ? undefined : src.hud.focused,
      prs: prsPill(src.prs.entries()),
      reconnecting: src.reconnect.redial,
      shells: shellsOf(src.processes, now),
      todos: list ? { list, open: src.hud.todosOpen } : undefined
    },
    queue: { canSteer: src.activity.busy !== null, rows: src.queue.rows() },
    route: {
      effort: info?.reasoning_effort ?? '',
      effortWire: info?.reasoning_effort_wire || undefined,
      fast: fastTier(info),
      model: info?.model ?? '',
      reasons: capsOf(info)?.reasoning
    },
    status: {
      branch: info?.branch ?? '',
      compressions: typeof usage?.compressions === 'number' ? usage.compressions : undefined,
      context: max > 0 ? { max, used } : undefined,
      cost: usage?.cost_usd ?? undefined,
      notice: src.notices.current(now),
      rates: {
        cache: typeof usage?.cache_hit_pct === 'number' ? usage.cache_hit_pct : undefined,
        tps: typeof usage?.avg_tps === 'number' && usage.avg_tps > 0 ? usage.avg_tps : undefined
      },
      title: src.title.text || undefined,
      tokens: typeof usage?.total === 'number' ? usage.total : undefined
    }
  }
}

/** The shells pill: the running processes (with their charts) and those that exited lately. */
function shellsOf(processes: DockSources['processes'], now: number): ShellsPill {
  const recent = processes.recent(now)
  const exited = recent.filter(p => !isRunning(p))

  return {
    charts: recent.flatMap(p => (p.chart && isRunning(p) ? [{ process: p, view: p.chart }] : [])),
    exited: exited.length,
    running: recent.length - exited.length,
    // The roster puts the newest exit first.
    tone: exited[0] ? processTone(exited[0].state.status) : 'muted'
  }
}
