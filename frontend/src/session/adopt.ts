// Adopting a session: what the pane takes on when a new, resumed or reattached session becomes the
// shown one. One ordered list of steps, run in this order on every adopt, so the order lives in one
// place: the ids first (everything after reads the adopted session), the per-session state, the
// history, then the stores that follow the session.

import type { SessionResumeResult } from '@hermes/shared/gateway-events'
import type { SessionInfo } from '@tui/types.js'

import type { Agents } from '../agents/store.js'
import type { Automation } from '../automation.js'
import type { NoticeStrip } from '../chrome/notices.js'
import { storedCompactions } from '../compaction.js'
import type { ConnectWatcher } from '../connections/watcher.js'
import { durable, type DurableSessionId, type LiveSessionId, type SessionIds, type SessionRef, type StoredSessionId } from '../core/ids.js'
import { busyFrom } from '../flow.js'
import type { PullRequests } from '../github/store.js'
import type { Media } from '../media.js'
import type { ToolCall } from '../model.js'
import type { PromptSheets } from '../prompts/sheets.js'
import type { Processes } from '../processes/store.js'
import type { Transcript } from '../transcript.js'
import type { Activity } from '../turn/activity.js'
import type { PromptQueue } from '../turn/queue.js'
import type { AdaptedSnapshot } from '../wire/rpc.js'
import { pendingRows } from '../wire/schemas.js'

import type { SessionState } from './state.js'
import type { SessionTitle } from './title.js'

/**
 * What the pane reads of session.create's or session.resume's result, from either gateway: the
 * shared gateway's subscription, and the state of a turn a resumed session may be in.
 */
export type Snapshot = Pick<AdaptedSnapshot, 'session_id'> &
  Partial<Pick<AdaptedSnapshot, 'messages' | 'subscription_id'>> &
  Partial<Pick<SessionResumeResult, 'inflight' | 'running' | 'status' | 'stored_session_id' | 'turn_started_at'>> & {
    info?: SessionInfo
  }

/** One adopt: the snapshot, the ids it names, and the ids shown before it. */
export interface Adoption {
  readonly r: Snapshot
  readonly ref: SessionRef
  readonly previous: SessionIds
}

/** One part of the pane that takes on an adopted session. */
export interface Adoptable {
  adopt(a: Adoption): void
}

/** What adopting reaches of the app. */
export interface AdoptHost {
  readonly state: SessionState
  readonly activity: Pick<Activity, 'busy' | 'endCompaction' | 'set'>
  readonly agents: Pick<Agents, 'adopt' | 'scan'>
  readonly automation: Pick<Automation, 'adopt'>
  readonly connect: Pick<ConnectWatcher, 'watch'>
  readonly media: Pick<Media, 'showAll'>
  readonly notices: Pick<NoticeStrip, 'reset'>
  readonly processes: Pick<Processes, 'poke'>
  readonly prs: Pick<PullRequests, 'adopt'>
  readonly queue: { readonly server: Pick<PromptQueue['server'], 'reset'> }
  readonly sheets: Pick<PromptSheets, 'dropAll'>
  readonly title: Pick<SessionTitle, 'adopt'>
  readonly transcript: Pick<Transcript, 'entries' | 'forgetCompactions' | 'inflight' | 'load' | 'usageBase'>
  /** Reads the adopted session's busy_input_mode into the state. */
  readBusyMode(): void
  /** Asks the gateway to stream session `sid`'s reasoning. */
  showThoughts(sid: LiveSessionId): void
  /** Names this pane the viewer of `now` (the plugin's connect results come here), no longer of `before`. */
  markViewer(now: DurableSessionId, before: StoredSessionId | null): void
  /** Writes the shown session's id where the plugin's hooks read it. */
  writeActiveSession(id: DurableSessionId): void
  /** Tells Tern the session's folder (OSC 7), when it moved. */
  reportCwd(): void
  /** The status warning shown last is the last session's. */
  forgetStatusNote(): void
  /** A history image landed: its card redraws. */
  imageLanded(call: ToolCall): void
  /** Asks for a render. */
  changed(): void
}

/** The steps of an adopt, in the order they run. */
export function adoptSteps(host: AdoptHost): readonly Adoptable[] {
  const { state, transcript } = host

  return [
    // The ids first: every step after reads the adopted session.
    {
      adopt: ({ ref }) => {
        state.ref = ref
      }
    },
    {
      adopt: ({ previous, ref }) => {
        if (ref.live !== previous.live) {
          // The last session's approvals and questions are not this one's (a resume hydrates its own after).
          host.sheets.dropAll()
          transcript.forgetCompactions()
          state.busyMode = 'queue'
        }
      }
    },
    // Read on every adopt: a reconnect may land on a gateway whose config changed.
    { adopt: () => host.readBusyMode() },
    // The session's own queue, from the snapshot (a reattach's rows of this pane become read-only rows).
    { adopt: ({ r }) => host.queue.server.reset(pendingRows(r.info)) },
    { adopt: ({ ref }) => host.showThoughts(ref.live) },
    {
      adopt: ({ previous, ref }) => {
        // This pane shows the session now: the plugin's Python half sends its connect results here as a card.
        host.markViewer(durable(ref), previous.stored)
        host.writeActiveSession(durable(ref))
      }
    },
    {
      adopt: ({ r }) => {
        state.info = r.info ?? state.info
        state.usage = r.info?.usage ?? null
      }
    },
    // Another session: its own name (or none yet) on the tab.
    { adopt: ({ r }) => host.title.adopt(typeof r.info?.title === 'string' ? r.info.title : undefined) },
    { adopt: () => host.reportCwd() },
    {
      adopt: ({ r }) => {
        // A resumed session may be mid-turn: Esc Esc stops it and new prompts go as busy_input_mode says.
        host.activity.set(busyFrom(r))
        // The last session's notices and status lines are not this one's.
        host.notices.reset()
        host.activity.endCompaction()
        host.forgetStatusNote()
        transcript.usageBase(r.info?.usage ?? undefined)
      }
    },
    // The last session's children are not this one's: a poll in flight for them drops its answer.
    { adopt: ({ ref }) => host.agents.adopt(ref.live) },
    {
      adopt: ({ r, ref }) => {
        if (r.messages?.length) {
          // The history leaves the compactions out; the store says where they were.
          transcript.load(r.messages, storedCompactions(durable(ref)))
          host.agents.scan()
          host.media.showAll(transcript.entries, call => host.imageLanded(call))
        }
      }
    },
    {
      adopt: ({ ref }) => {
        // The new session's processes and PRs (and none of the last one's), and its open connect cards.
        host.processes.poke()
        host.connect.watch()
        host.prs.adopt()
        host.automation.adopt(ref.live)
      }
    },
    {
      adopt: ({ r }) => {
        if (r.inflight) {
          transcript.inflight(r.inflight, host.activity.busy?.startedAt)
        }
      }
    },
    { adopt: () => host.changed() }
  ]
}

/** Runs each step of an adopt, in order. */
export function adoptAll(steps: readonly Adoptable[], a: Adoption) {
  for (const step of steps) {
    step.adopt(a)
  }
}
