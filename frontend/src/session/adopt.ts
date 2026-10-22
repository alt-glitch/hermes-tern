// Adopting a session: what the pane takes on when a new, resumed or reattached session becomes the
// shown one. One ordered list of steps, run in this order on every adopt, so the order lives in one
// place: the ids first (everything after reads the adopted session), the transcript's reset (the
// only one), the per-session state, the history, then the stores that follow the session.

import type { SessionResumeResult } from '@hermes/shared/gateway-events'
import type { SessionInfo } from '@tui/types.js'

import type { Agents } from '../agents/store.js'
import type { NoticeStrip } from '../chrome/notices.js'
import type { Sidebar } from '../chrome/sidebar.js'
import type { ConnectWatcher } from '../connections/watcher.js'
import { durable, type DurableSessionId, type LiveSessionId, type SessionIds, type SessionRef, type StoredSessionId } from '../core/ids.js'
import type { PullRequests } from '../github/store.js'
import { storedCompactions } from '../hermes/compactions.js'
import type { Media } from '../media.js'
import type { ToolCall } from '../model.js'
import type { Processes } from '../processes/store.js'
import type { PromptSheets } from '../prompts/sheets.js'
import type { Transcript } from '../transcript/store.js'
import type { Activity } from '../turn/activity.js'
import type { PromptQueue } from '../turn/queue.js'
import type { AdaptedSnapshot } from '../wire/rpc.js'
import { pendingRows } from '../wire/schemas.js'

import type { Automation } from './automation.js'
import { busyFrom } from './flow.js'
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
  readonly queue: Pick<PromptQueue, 'adopt'> & { readonly server: Pick<PromptQueue['server'], 'reset'> }
  readonly sheets: Pick<PromptSheets, 'dropAll'>
  readonly sidebar: Pick<Sidebar, 'adopt'>
  readonly title: Pick<SessionTitle, 'adopt'>
  readonly transcript: Pick<Transcript, 'entries' | 'inflight' | 'load' | 'reset'>
  /** Reads the adopted session's busy_input_mode into the state. */
  readBusyMode(): void
  /** Asks the gateway to stream session `sid`'s reasoning. */
  showThoughts(sid: LiveSessionId): void
  /** Names this pane the viewer of `now` (the plugin's connect results come here), no longer of `before`. */
  markViewer(now: DurableSessionId, before: StoredSessionId | null): void
  /** Writes the shown session's id where the plugin's hooks read it. */
  writeActiveSession(id: DurableSessionId): void
  /** Records the shown session as this Tern pane's, which `hermes tern` resumes after the pane's program dies. */
  markPane(id: DurableSessionId): void
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
      adopt: ({ previous, r, ref }) => {
        const other = ref.live !== previous.live
        // One step, so nothing of the last session's transcript outlives it: its entries, live
        // turn, reason line, and (another session's) counters and compactions.
        transcript.reset({ session: other ? 'other' : 'same', usage: r.info?.usage ?? undefined })

        if (other) {
          // The last session's approvals and questions are not this one's (a resume hydrates its own after).
          host.sheets.dropAll()
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
        host.markPane(durable(ref))
      }
    },
    {
      adopt: ({ r }) => {
        // A snapshot without info leaves none: the last session's folder, model and branch are not this one's.
        state.info = r.info ?? null
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
    // Prompts held for another session go back to the composer, not to this one. After the history:
    // load() keeps only the welcome, so the notice that says so is written into the loaded transcript.
    { adopt: ({ ref }) => host.queue.adopt(ref) },
    {
      adopt: ({ ref }) => {
        // The new session's processes, PRs and git state (and none of the last one's), and its open connect cards.
        host.processes.poke()
        host.connect.watch()
        host.prs.adopt()
        host.sidebar.adopt(ref.live)
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
