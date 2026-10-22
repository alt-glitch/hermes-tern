// What the chat pane is made of: every store, made in the order they depend on each other, and
// wired to each other, to the app's ports (the sheets' and the title's host) and to the actions.
// The actions are made last, over these stores, so a store reaches them through `act()` when it
// calls back; each closure here reads what it calls when it runs, never while the stores are made.

import type { Session } from '@stencil-hq/tern'
import type { GatewayClient } from '@tui/gatewayClient.js'

import { Agents } from '../agents/store.js'
import { Hud } from '../chrome/hud.js'
import { NoticeStrip } from '../chrome/notices.js'
import { Reconnect } from '../chrome/reconnect.js'
import { Sidebar } from '../chrome/sidebar.js'
import { Theme } from '../chrome/theme.js'
import { dispatched } from '../commands/slash.js'
import type { LaunchEnv } from '../config/env.js'
import { markViewer } from '../connections/cards.js'
import { ConnectWatcher } from '../connections/watcher.js'
import { Disposables } from '../core/disposables.js'
import { durable } from '../core/ids.js'
import { Attachments } from '../draft/attachments.js'
import { Composer } from '../draft/composer.js'
import type { Presses } from '../draft/keys.js'
import type { Warned } from '../gateway/handlers/chrome.js'
import { PullRequests } from '../github/store.js'
import { writeActiveSessionFile } from '../hermes/activeSessionFile.js'
import { Media } from '../media.js'
import { Completion } from '../overlays/completion.js'
import { OverlayStack } from '../overlays/overlay.js'
import { openUrl } from '../overlays/pullRequests.js'
import { Cron } from '../processes/cron.js'
import { Processes } from '../processes/store.js'
import { hermesAuthor } from '../processes/widgets/author.js'
import { chartMemory } from '../processes/widgets/memory.js'
import { PromptSheets } from '../prompts/sheets.js'
import { PrAside } from '../prs/aside.js'
import { adoptSteps } from '../session/adopt.js'
import { Automation } from '../session/automation.js'
import { SessionLifecycle } from '../session/lifecycle.js'
import { markPane } from '../session/pane.js'
import { SessionState } from '../session/state.js'
import { showThoughts } from '../session/thoughts.js'
import { SessionTitle } from '../session/title.js'
import type { SettingsSource } from '../settings.js'
import type { SurfaceHost } from '../surface/host.js'
import { Transcript } from '../transcript/store.js'
import { Activity } from '../turn/activity.js'
import { PromptQueue } from '../turn/queue.js'
import { canDrain, canSwitch, PromptRouter } from '../turn/router.js'
import { randomTip, type WelcomeContext } from '../view/welcome.js'

import type { AppActions } from './actions.js'
import type { ChatPorts } from './ports.js'

/** What the stores are made over: the outside parties, what entry.ts read at startup, the app's later parts. */
export interface StoresDeps {
  readonly tern: Session
  readonly gw: GatewayClient
  readonly version: string
  readonly launch: LaunchEnv
  readonly settings: SettingsSource
  /** The actions, made over these stores: read only when a store calls back. */
  act(): AppActions
  /** The surface run() opens. */
  surface(): SurfaceHost
}

/**
 * Every store of the chat pane: App lends some as ports, and the actions, the frame and the
 * gateway's handlers take the rest.
 */
export type ChatStores = ReturnType<typeof chatStores>

/** Makes every store of the chat pane over `chat`'s ports, in the order they depend on each other. */
export function chatStores(chat: ChatPorts, { act, gw, launch, settings, surface, tern, version }: StoresDeps) {
  const changed = () => chat.changed()
  const saved = settings.load()
  const jobCharts = saved.jobCharts !== false
  /** The open session: its ids, info, usage and busy-input mode; every write renders. */
  const session = new SessionState(changed)
  const transcript = new Transcript()
  /** The working line's busy state and the compaction phase: their one owner. */
  const activity = new Activity()
  /** What the subagent, process and automation stores read of the app: the shown runtime id on each use. */
  const live = {
    // A subagent ended: the PRs it linked are filed under this conversation (pull_requests.py).
    agentEnded: () => prs.relink(),
    changed,
    gw,
    // A command's dispatch envelope from outside a typed command (a goal or loop sheet's button).
    runDispatch: (raw: unknown, title: string) => dispatched(raw, act().slash, { arg: '', title }),
    get sid() {
      return session.ref.live
    },
    transcript
  }
  /** Images tool calls showed, a URL's bytes fetched once and sent as a blob. */
  const media = new Media({ blob: (bytes, mime) => act().blob(bytes, mime) })
  /** The session's subagents, followed while they run (Task cards, the pill, the hub). */
  const agents = new Agents(live)
  /**
   * The session's background processes (the shells pill, the Background sheet, background cards),
   * with live charts unless settings.json's `jobCharts` is false.
   */
  const processes = new Processes(live, { author: hermesAuthor(), enabled: () => jobCharts, memory: chartMemory() })
  const cron = new Cron(chat)
  const sidebar = new Sidebar(chat)
  /** The session's standing /goal and /loop (the dock line above the pills and its sheets). */
  const automation = new Automation(live)
  /** The session's title, as Hermes names it: on the status strip and the tab. */
  const title = new SessionTitle(chat)
  /** The pills above the composer: the one holding the keys, and the todo panel's fold. */
  const hud = new Hud({ changed, open: pill => act().openPill(pill) })
  /** The conversation's PRs; links are stored under the stored session id the tools see. */
  const prs = new PullRequests({ changed, cwd: () => session.info?.cwd || null, sid: () => durable(session.ref) })
  /** The pull request docked at the pane's right edge (the PR aside). */
  const prAside = new PrAside({
    changed,
    notice: (text, tone) => chat.notice(text, tone),
    open: openUrl,
    prs,
    reveal: id => chat.reveal(id),
    scroll: (id, to) => chat.scroll(id, to)
  })
  const composer = new Composer()
  /** The open overlays; a modal one takes the keys from the completion list. */
  const stack = new OverlayStack({
    changed,
    closed: overlay => sheets.closed(overlay),
    opened: overlay => {
      if (overlay.modal) {
        // The sheet owns the keys now: a list or reply for the composer would only land under it.
        completion.dismiss()
      }
    }
  })
  /** Timers with no field of their own (a compaction's summary read, the quit's detach wait). */
  const timers = new Disposables()
  /** The last lone Esc and the first Ctrl+C of a quit, for the double presses. */
  const presses: Presses = { esc: 0, exit: 0 }
  /** The prompt sheets the gateway's questions opened, and their approval-queue ids. */
  const sheets = new PromptSheets(chat)
  /** The connect cards, kept current from the plugin's files. */
  const connect = new ConnectWatcher({ changed, openUrl, tell: text => act().submit(text, false), transcript })
  /** The gateway connection: down until the next gateway.ready, and its redial line. */
  const reconnect = new Reconnect(chat)
  /** The backend warnings shown already (stray output, the last status warning), so each stays one line. */
  const warned: Warned = { protocol: false, status: undefined }
  /** The gateway's keyed notices (credits, a slow start); the newest rides the status strip. */
  const notices = new NoticeStrip(chat)
  /** The draft's images, those still uploading, and the launcher's startup image. */
  const attachments = new Attachments(
    {
      attachToHead: image => queue.attachToHead(image),
      blob: (bytes, mime) => act().blob(bytes, mime),
      changed,
      cwd: () => session.info?.cwd || launch.cwd,
      gw,
      launchCwd: launch.cwd,
      note: (text, tone) => transcript.notice(text, tone),
      sid: () => session.ref.live
    },
    { startup: launch.image }
  )
  /** The prompts waiting behind the turn: held here, and the shared gateway's queue for this session. */
  const queue: PromptQueue = new PromptQueue({
    busy: () => Boolean(activity.busy),
    canDrain: () => canDrain(act().gates()),
    changed,
    expanded: (sid, prompt) => router.expanded(sid, prompt),
    gw,
    restore: prompt => act().restore(prompt),
    send: prompt => router.send(prompt, { queued: true }),
    ticket: () => session.ticket(),
    transcript
  })
  /** Where each prompt goes: sent, the busy path, behind the turn, or held. */
  const router: PromptRouter = new PromptRouter({
    activity,
    changed,
    gates: () => act().gates(),
    gw,
    queue,
    restore: prompt => act().restore(prompt),
    session,
    ticket: () => session.ticket(),
    transcript
  })
  const shared = {
    activity,
    agents,
    automation,
    changed,
    composer,
    connect,
    hud,
    media,
    notices,
    overlays: stack.items,
    prAside,
    presses,
    processes,
    prs,
    queue,
    reconnect,
    session,
    sheets,
    sidebar,
    state: session,
    timers,
    title,
    transcript
  }
  /** Which session the pane shows and how it switches: views, held requests, and the steps each adopt runs in order. */
  const life = new SessionLifecycle(
    {
      attachStartup: sid => act().attachStartupImage(sid),
      awaitingStartup: () => attachments.awaitingStartup,
      canSwitch: () => canSwitch(act().gates()),
      changed,
      cols: () => tern.caps.cols,
      drain: () => queue.drain(),
      gw,
      launch,
      rename: (sid, text) => title.rename(sid, text),
      request: req => act().onRequest(req),
      sheets,
      state: session,
      transcript
    },
    adoptSteps({
      ...shared,
      forgetStatusNote: () => {
        warned.status = undefined
      },
      imageLanded: call => act().imageLanded(call),
      markPane: id => markPane(launch, id),
      markViewer,
      readBusyMode: () => void act().readBusyMode(),
      reportCwd: () => act().reportCwd(),
      showThoughts: sid => showThoughts({ gw, notice: (text, tone) => chat.notice(text, tone), settings }, sid),
      writeActiveSession: writeActiveSessionFile
    })
  )
  /** Whose colors the surface wears, and the gateway's skin. */
  const theme = new Theme({ palette: palette => surface().palette(palette), settings }, saved.theme ?? 'tern')
  const completion = new Completion(chat, gw, () => session.ref.live)
  const welcome: WelcomeContext = { tip: randomTip(launch.pythonSrcRoot), version: version && version !== 'unknown' ? `v${version}` : '' }

  return { ...shared, attachments, completion, cron, life, router, stack, theme, warned, welcome }
}

/** Stops what the stores run on their own: every timer, the polls and the sidebar's reads. */
export function disposeStores(s: ChatStores) {
  s.timers.dispose()
  s.connect.dispose()
  s.notices.dispose()
  s.reconnect.dispose()
  s.title.dispose()
  s.agents.dispose()
  s.processes.dispose()
  s.prs.dispose()
  s.sidebar.dispose()
  s.cron.dispose()
}
