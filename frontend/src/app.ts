// The app: one inline Tern surface (role `omp.session`, so Tern's chat styles
// apply) over one tui_gateway session. Gateway events fold into the
// transcript, keys go to the top overlay or the composer, and every change
// schedules one render of the whole view; the SDK diffs it into frame ops.

import { appendFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'

import type { SessionResumeResult, Usage } from '@hermes/shared/gateway-events'
import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import { parseCommandDispatch } from '@hermes/shared/slash'
import type { Key, ScrollTo, Session, TspEvent } from '@stencil-hq/tern'
import { describeSlashExecError, isUnsupportedCommand, shouldFallbackToDispatch } from '@tui/app/userMessages.js'
import { localCreationOptions } from '@tui/canonicalGateway.js'
import { usageFromTick } from '@tui/domain/usage.js'
import type { GatewayClient } from '@tui/gatewayClient.js'
import type { AnyGatewayEvent } from '@tui/gatewayTypes.js'
import type { SessionInfo } from '@tui/types.js'

import logo from '../assets/logo.png'

import { agentName, Agents } from './agents/store.js'
import { type ChatPorts, type SessionView, sessionView } from './app/ports.js'
import { Automation } from './automation.js'
import { Hud, pills, type Pill, type SheetPill, todos } from './chrome/hud.js'
import { isLoginNotice, NoticeStrip } from './chrome/notices.js'
import { Reconnect } from './chrome/reconnect.js'
import { Theme } from './chrome/theme.js'
import { copyToClipboard } from './clipboard.js'
import { type LaunchEnv, readLaunchEnv } from './config/env.js'
import { localCommand } from './commands.js'
import { Composer } from './composer.js'
import { interruptTurn, redirectTurn, steerTurn } from './controlCommands.js'
import { Disposables } from './core/disposables.js'
import { errorText } from './core/errors.js'
import {
  type DurableSessionId,
  durable,
  entryId,
  isLive,
  type LiveSessionId,
  liveSessionId,
  newInputId,
  NO_SESSION,
  type PrKey,
  type SessionIds,
  type StoredSessionId,
  storedSessionId,
  toolCallId
} from './core/ids.js'
import { RenderScheduler } from './core/scheduler.js'
import { fastTier } from './fast.js'
import { type Busy, busyFrom, ownsEvent, Switches } from './flow.js'
import { protocolNote, slowStartNotes } from './backendNotes.js'
import { moaLabel, moaReferenceLabel } from './moa.js'
import type { Overlay } from './overlay.js'
import { writeActiveSessionFile } from './hermes/activeSessionFile.js'
import { imagePathOf, withClipboardImage } from './hermes/clipboardImage.js'
import { type Attachment, imageSize, uploadImage } from './hermes/images.js'
import { Media } from './media.js'
import type { ImageSource, NoticeEntry, ToolCall, UserAttachment } from './model.js'
import { interpolate, shellError, shellExec, shellLines, typedCommands } from './hermes/shell.js'
import { sharedPromptId, sharedPromptRequest } from './hermes/sharedPrompts.js'
import { openAgents } from './overlays/agents.js'
import { openAutomation } from './overlays/automation.js'
import { openBackground } from './overlays/background.js'
import { Completion } from './overlays/completion.js'
import { openModelPicker } from './overlays/models.js'
import { openEffortPicker } from './overlays/effort.js'
import { openHelp } from './overlays/help.js'
import { capsOf } from './modelCaps.js'
import { promptOverlay, promptTimeoutNotice } from './overlays/prompts.js'
import { openPrMenu, openPrSheet, openUrl, prsPill } from './overlays/pullRequests.js'
import { allConnected, claimTold, CONNECT_TOOL, connectedMessage, continueMessage, loadConnect, markViewer, POLL_MS, waiting } from './connections.js'
import { LINK_TOOLS } from './github/links.js'
import { PullRequests } from './github/store.js'
import { Cron } from './processes/cron.js'
import { PrAside } from './prs/aside.js'
import { applyEffort, cycleEffort, DEFAULT_EFFORT } from './session/effort.js'
import { showThoughts } from './session/thoughts.js'
import { SessionTitle } from './session/title.js'
import { SessionViews } from './session/views.js'
import { Sidebar } from './sidebar.js'
import type { SessionHost } from './sessionCommands.js'
import { ambiguousNotice, CommandCatalog, resolveSlashName } from './slashResolve.js'
import { statusEffect } from './status.js'
import { isRunning as processRuns, Processes, processTone } from './processes/store.js'
import { hermesAuthor } from './processes/widgets/author.js'
import { chartMemory } from './processes/widgets/memory.js'
import { fileSettings, type SettingsSource, type ThemeMode } from './settings.js'
import { type BusyMode, busyModeOf, type OwnAdmission, ServerQueue, type ServerQueued } from './serverQueue.js'
import { INPUT_ID, SurfaceHost } from './surface/host.js'
import { runInput } from './surface/input.js'
import { reportCwd } from './surface/osc.js'
import { Transcript } from './transcript.js'
import { internalNotice } from './transcript/messages.js'
import { storedCompactions } from './compaction.js'
import { dockNodes, type QueuedRow } from './view/dock.js'
import { homeTilde } from './view/format.js'
import { entryNode } from './view/transcript.js'
import { type AdaptedSnapshot, admissionOf, rpc } from './wire/rpc.js'
import { pendingRows, usageCounters } from './wire/schemas.js'
import { busyLabel, preparingLabel } from './workLog.js'
import { openSidebar, specOf } from './watch/spec.js'
import { randomTip, type WelcomeContext } from './view/welcome.js'

const EXIT_ARM_MS = 1500
/** Two Esc presses within this window are a double Esc (Ink's DOUBLE_ESC_MS). */
const DOUBLE_ESC_MS = 500
/** How long a prompt's Copy button reads Copied. */
const COPIED_MS = 1500
/**
 * What the pane reads of session.create's or session.resume's result, from either gateway: the
 * shared gateway's subscription, and the state of a turn a resumed session may be in.
 */
type Snapshot = Pick<AdaptedSnapshot, 'session_id'> &
  Partial<Pick<AdaptedSnapshot, 'messages' | 'subscription_id'>> &
  Partial<Pick<SessionResumeResult, 'inflight' | 'running' | 'status' | 'stored_session_id' | 'turn_started_at'>> & {
    info?: SessionInfo
  }

/**
 * An uploaded image a prompt carries (the shared gateway takes it on prompt.submit), with the name
 * its chip shows, and the thumbnail and size the chip and the prompt's bubble show.
 */
type Image = Attachment & { name: string; preview?: ImageSource; caption?: string }

/**
 * What a prompt of images alone asks, as Ink (ui-tui/src/app/submissionCore.ts) and the desktop
 * (use-prompt-actions/submit.ts) send it: Hermes takes no empty prompt text.
 */
const IMAGE_ONLY_PROMPT = 'What do you see in this image?'

/** How long quitting waits for the sessions to detach. */
const QUIT_DETACH_MS = 1500

/** A prompt waiting for the turn, with the images that were attached when it was entered. */
export interface Queued {
  text: string
  images: Image[]
  /** Typed by the user: its `{!cmd}`s run when it is sent. */
  expand?: boolean
  /** Text pasted into it: a `{!cmd}` from a paste stays as written. */
  pasted?: readonly string[]
  /** What the transcript, the queue and Edit show instead of `text` (a skill's invocation, not its body). */
  display?: string
}

/** A prompt this pane admitted into the shared gateway's queue: as typed (for Edit), and as sent. */
interface Admitted {
  item: Queued
  text: string
}

/** Runs the Tern frontend until the user quits; resolves the exit code. */
export class App implements ChatPorts {
  readonly transcript = new Transcript()
  /** Images tool calls showed, a URL's bytes fetched once and sent as a blob. */
  readonly media = new Media({ blob: (bytes, mime) => this.#blob(bytes, mime) })
  /** The session's subagents, followed while they run (Task cards, the pill, the hub). */
  readonly agents: Agents = new Agents(this)
  /** The session's background processes (the shells pill, the Background sheet, background cards). */
  readonly processes: Processes = new Processes(this, { author: hermesAuthor(), enabled: () => this.#jobCharts, memory: chartMemory() })
  readonly cron: Cron = new Cron(this)
  readonly sidebar: Sidebar = new Sidebar(this)
  /** The session's standing /goal and /loop (the dock line above the pills and its sheets). */
  readonly automation: Automation = new Automation(this)
  /** The session's title, on the status strip and the tab. */
  readonly #title: SessionTitle = new SessionTitle(this)
  /** The pills above the composer: the one holding the keys, and the todo panel's fold. */
  readonly #hud = new Hud({ changed: () => this.changed(), open: pill => this.#openPill(pill) })
  /** The conversation's PRs; links are stored under the stored session id the tools see. */
  readonly prs: PullRequests = new PullRequests({
    changed: () => this.changed(),
    cwd: () => this.info?.cwd || null,
    sid: () => durable(this.#ids)
  })
  /** The pull request docked at the pane's right edge (the PR aside). */
  readonly prAside: PrAside = new PrAside({
    changed: () => this.changed(),
    notice: (text, tone) => this.notice(text, tone),
    open: openUrl,
    prs: this.prs,
    reveal: id => this.reveal(id),
    scroll: (id, to) => this.scroll(id, to)
  })
  readonly composer = new Composer()
  readonly overlays: Overlay[] = []
  /** The open session's ids: the runtime id requests name, and the stored id it is saved under. */
  #ids: SessionIds = NO_SESSION
  info: SessionInfo | null = null
  /** The session as the ports read it: its ids and `info`, live. */
  readonly session: SessionView = sessionView(this, () => this.#ids)
  usage: Usage | null = null
  busy: Busy | null = null
  /** Prompts held here until they can be sent: no session yet, a switch in flight, or a private gateway's busy turn. */
  queue: Queued[] = []
  /** The shared gateway's queue for this session: its FIFO, this pane's admissions, the bubbles they owe. */
  readonly #server = new ServerQueue<Admitted>()
  /** What Enter does while a turn runs (`display.busy_input_mode`); queue until the gateway says. */
  #busyMode: BusyMode = 'queue'
  readonly #tern: Session
  readonly #gw: GatewayClient
  readonly #completion: Completion
  /** `commands.catalog`, for resolving a typed alias or prefix (`/hea` → /heartbeat). */
  readonly #catalog: CommandCatalog
  readonly #welcome: WelcomeContext
  readonly #launch: LaunchEnv
  readonly #settings: SettingsSource
  #surface!: SurfaceHost
  readonly #renders = new RenderScheduler(() => this.#render())
  /** Timers with no field of their own (a compaction's summary read, the quit's detach wait). */
  readonly #timers = new Disposables()
  #exitArmed = 0
  #lastEsc = 0
  #done = Promise.withResolvers<number>()
  readonly #switches = new Switches()
  /** Server requests for another session, kept while a switch is in flight. */
  #heldRequests: ServerRequest[] = []
  /** The sessions this pane views: its subscriptions, detaches in flight, and superseded switches' results. */
  readonly #views: SessionViews
  /** Open approval prompts' overlay keys → their approval-queue `request_id` (what approval.cancelled names). */
  readonly #approvalIds = new Map<string, string>()
  /** The launcher's startup image until it is attached to the first session (the queue waits for it). */
  #startupImage: string
  /** The images attached to the draft: the next prompt entered takes them. */
  #attachments: Image[] = []
  /** The folder last reported to Tern by OSC 7. */
  #reportedCwd: string | undefined
  /** Images being read or uploaded for the draft: an "attaching…" chip each until they land. */
  #attaching: { name: string }[] = []
  /** Whose colors the surface wears, and the gateway's skin. */
  readonly #theme: Theme
  /** Background processes get live charts (settings.json `jobCharts`). */
  readonly #jobCharts: boolean
  /** The prompt whose Copy button reads Copied, until the timer clears it. */
  #copied: string | undefined
  #copiedTimer: NodeJS.Timeout | undefined
  /** The gateway connection: down until the next gateway.ready, and its redial line. */
  readonly #reconnect = new Reconnect(this)
  /** Stray backend output was reported once already. */
  #protocolWarned = false
  /** The gateway's keyed notices (credits, a slow start); the newest rides the status strip. */
  readonly #notices = new NoticeStrip(this)
  /**
   * A compaction runs (Hermes' own, or /compress): the working line says so until its done edge,
   * and with no turn running the dock shows it and prompts queue behind it.
   */
  #compacting: { since: object; startedAt: number } | undefined
  /** The status warning shown last, so a repeated one stays one line. */
  #lastStatusNote: string | undefined

  /** `launch` and `settings` are what entry.ts read once at startup; unset, each reads its default. */
  constructor(tern: Session, gw: GatewayClient, version: string, { launch = readLaunchEnv(), settings = fileSettings() }: { launch?: LaunchEnv; settings?: SettingsSource } = {}) {
    this.#tern = tern
    this.#gw = gw
    this.#views = new SessionViews(gw)
    this.#launch = launch
    this.#settings = settings
    this.#startupImage = launch.image
    const saved = settings.load()
    this.#theme = new Theme({ palette: palette => this.#surface.palette(palette), settings }, saved.theme ?? 'tern')
    this.#jobCharts = saved.jobCharts !== false
    this.#completion = new Completion(this, gw, () => this.sid)
    this.#catalog = new CommandCatalog(gw)
    this.#welcome = {
      tip: randomTip(launch.pythonSrcRoot),
      version: version && version !== 'unknown' ? `v${version}` : ''
    }
  }

  /** The open session's runtime id: null before the first session and while the gateway is down. */
  get sid(): LiveSessionId | null {
    return this.#ids.live
  }

  /** Sets the runtime id, keeping the stored one (tests arrange a session this way). */
  set sid(id: string | null) {
    this.#ids = { live: id === null ? null : liveSessionId(id), stored: this.#ids.stored }
  }

  /** The stored (database) id of the open session: what `session.list` rows are keyed by. */
  get storedSid(): StoredSessionId | null {
    return this.#ids.stored
  }

  /** Sets the stored id, keeping the runtime one (tests arrange a session this way). */
  set storedSid(id: string | null) {
    this.#ids = { live: this.#ids.live, stored: id === null ? null : storedSessionId(id) }
  }

  /** The session's title, as Hermes names it (`session.title`); '' while it has none. */
  get title(): string {
    return this.#title.text
  }

  /** The gateway, for overlays that issue their own RPCs. */
  get gw(): GatewayClient {
    return this.#gw
  }

  async run(): Promise<number> {
    this.#surface = new SurfaceHost(this.#tern, 'hermes')
    this.#theme.apply()

    if (this.#tern.caps.features.includes('blobs')) {
      this.#welcome.logo = this.#tern.blob(logo, 'image/png')
    }

    this.transcript.push({ id: entryId('welcome'), kind: 'welcome' })

    // `hermes -q …`: the launcher's query is the first prompt, sent literally once the first session is adopted.
    const query = this.#launch.query

    if (query || this.#startupImage) {
      this.queue.push({ images: [], text: query || 'What do you see in this image?' })
    }

    const log = this.#launch.eventLog

    // Development (the lab, and the golden replays' fixtures): one JSON line per gateway event, as
    // the event itself, and per server request, as `{"request": {id, method, params}}`.
    this.#gw.on('event', (ev: AnyGatewayEvent) => {
      if (log) {
        appendFileSync(log, `${JSON.stringify(ev)}\n`)
      }

      this.#onGatewayEvent(ev)
    })
    this.#gw.on('request', (req: ServerRequest) => {
      if (log) {
        appendFileSync(log, `${JSON.stringify({ request: { id: req.id, method: req.method, params: req.params } })}\n`)
      }

      this.#onRequest(req)
    })
    this.#gw.on('exit', (code: null | number) => {
      // Once per outage: each failed redial emits another exit. An attached gateway (and its turn) lives on.
      const lost = this.#reconnect.lost(this.#gw.attached, code)

      if (lost) {
        this.transcript.notice(lost.text, lost.tone)
      }

      // The runtime session died with the process: prompts queue until the next gateway.ready reattaches.
      this.#ids = { live: null, stored: this.#ids.stored }
      this.busy = null
      // Nothing can answer the sheets now; the reattach re-opens the questions still pending.
      this.#heldRequests = []
      this.#dropPrompts(() => true)
      this.transcript.interrupt()
      this.changed()
    })
    this.#gw.drain()
    this.processes.poke()
    this.#render()
    this.#surface.focus(INPUT_ID)
    // Keys and Tern events until the pane closes, each followed by a render; then the app quits.
    void runInput(this.#tern, {
      after: () => this.changed(),
      onError: error => this.transcript.notice(`Input failed: ${errorText(error)}`, 'error'),
      onEvent: event => this.#onTernEvent(event),
      onKey: key => this.#onKey(key)
    }).then(() => this.quit())

    const code = await this.#done.promise
    // Bounded, as Ink's deferExitForClose: a dead socket must not hold the terminal.
    await Promise.race([
      this.#views.leaveAll('tui_shutdown'),
      new Promise(resolve => this.#timers.timeout(() => resolve(undefined), QUIT_DETACH_MS))
    ])
    this.dispose()
    await this.#tern.close()
    this.#gw.kill('exit')

    return code
  }

  /**
   * Stops what the pane runs on its own: every timer, the stores' polls and the sidebar's reads.
   * Quitting calls it once the sessions detached (or the wait gave up), before Tern closes.
   */
  dispose() {
    for (const timer of [this.#copiedTimer, this.#connectTimer]) {
      clearTimeout(timer)
    }

    this.#timers.dispose()
    this.#notices.dispose()
    this.#reconnect.dispose()
    this.#title.dispose()
    this.agents.dispose()
    this.processes.dispose()
    this.prs.dispose()
    this.sidebar.dispose()
  }

  // ── OverlayHost ────────────────────────────────────────────────────

  open(overlay: Overlay) {
    const same = this.overlays.find(o => o.key === overlay.key)

    if (same) {
      this.close(same)
    }

    this.overlays.push(overlay)

    if (overlay.modal) {
      // The sheet owns the keys now: a list or reply for the composer would only land under it.
      this.#completion.dismiss()
    }

    this.changed()
  }

  close(overlay: Overlay) {
    // By identity: a stale callback of a replaced overlay must not close its same-key successor.
    const at = this.overlays.indexOf(overlay)

    if (at >= 0) {
      this.overlays.splice(at, 1)
      this.#approvalIds.delete(overlay.key)
      overlay.onClose?.()
      this.changed()
    }
  }

  changed() {
    this.#renders.request()
  }

  /** A notice in the transcript, rendered now. */
  notice(text: string, tone?: NoticeEntry['tone']) {
    this.transcript.notice(text, tone)
    this.changed()
  }

  /** An error nothing caught (a rejected promise no caller awaited): shown, so the pane lives on. */
  fault(reason: unknown) {
    this.transcript.notice(`Unexpected error: ${errorText(reason)}`, 'error')
    this.changed()
  }

  // ── Input ──────────────────────────────────────────────────────────

  #onKey(key: Key) {
    const top = this.overlays.at(-1)

    if (key.ctrl && key.name === 'c') {
      // The sheet on top answers first: a prompt's safe answer (deny, skip, cancel), a picker closes.
      if (top) {
        return top.cancel ? top.cancel() : this.close(top)
      }

      return this.#ctrlC()
    }

    if (top?.onKey(key)) {
      return
    }

    if (top?.modal) {
      return
    }

    // Before the completion: Enter on a focused pill opens it.
    if (this.#hudKey(key)) {
      return
    }

    if (this.#completion.onKey(key)) {
      return
    }

    // A single Esc never cancels work (Ink's resolveDoubleEscAction): a second one within
    // DOUBLE_ESC_MS clears a draft into the prompt history, else stops the running turn.
    if (key.name === 'escape') {
      const now = Date.now()
      const double = now - this.#lastEsc <= DOUBLE_ESC_MS
      this.#lastEsc = double ? 0 : now

      if (double && this.#hasDraft()) {
        this.#clearDraft()
      } else if (double && this.busy) {
        this.#interrupt()
      }

      return
    }

    if (key.shift && key.name === 'tab') {
      return cycleEffort(this)
    }

    // By the Alt modifier only: a typed å, ∫, ß or π (macOS Option without Meta, or a keyboard
    // that has the letter) is text for the composer. Alt+B/F/D stay the composer's readline word
    // keys: a Mac terminal sends Option+←/→ as ESC b / ESC f, which arrive as Alt+B / Alt+F.
    if (key.alt && !key.ctrl && !key.meta) {
      switch (key.name) {
        case 'a':
          return openAgents(this)

        case 'j':
          return openBackground(this)

        case 's':
          return this.toggleSidebar()

        case 'p':
          return openPrMenu(this)
      }
    }

    if (key.alt && key.name === 'up' && this.#queuedCount()) {
      return this.#dequeue(0)
    }

    if (key.alt && key.name === 'enter' && this.busy && this.#queuedCount() && !this.composer.text) {
      return this.#steerQueued(0)
    }

    if (key.ctrl && key.name === 'd' && !this.#hasDraft()) {
      return this.quit()
    }

    // An image: a paste with no text (what a terminal sends for a clipboard image), a pasted or
    // dropped image path, or Ctrl+V.
    if (key.name === 'paste' && this.#pasteImage(key.text ?? '')) {
      return
    }

    if (key.ctrl && key.name === 'v' && !key.alt && !key.meta) {
      return void this.attachClipboardImage(false)
    }

    const action = this.composer.key(key)

    if (action === 'submit') {
      this.#submitDraft()
    }
  }

  #onTernEvent(ev: TspEvent) {
    if (ev.ev === 'action' && ev.act === 'open-agent' && ev.value) {
      void this.openAgent(ev.value)

      return
    }

    if (ev.ev === 'action' && ev.act === 'open-process' && ev.value) {
      return openBackground(this, ev.value)
    }

    // A connect card's Authorize: the app's link in the browser.
    if (ev.ev === 'action' && ev.act === 'open-url' && ev.value) {
      return openUrl(ev.value)
    }

    if (ev.ev === 'action' && ev.act === 'connect-continue' && ev.value) {
      return this.#connectContinue(ev.value)
    }

    // `<card>:<app>`: the card names the row, as call ids repeat.
    if (ev.ev === 'action' && ev.act === 'connect-open' && ev.value) {
      const at = ev.value.lastIndexOf(':')

      return this.#connectOpen(ev.value.slice(0, at), ev.value.slice(at + 1))
    }

    if (ev.ev === 'focus' && ev.id === INPUT_ID && !this.overlays.at(-1)?.modal) {
      this.#hud.release()
      this.#surface.focus(INPUT_ID)
    }
  }

  /** The agent's todo list while it matters: a turn runs, or something on it is still open. */
  #todos() {
    return todos(this.transcript.currentTodos(), Boolean(this.busy))
  }

  /** The pills above the composer, left to right. */
  #pills(now = Date.now()): Pill[] {
    return pills({
      agents: this.agents.running().length,
      busy: Boolean(this.busy),
      goal: Boolean(this.automation.goal),
      loop: Boolean(this.automation.loop(now)),
      prs: this.prs.entries().length,
      shells: this.processes.recent(now).length,
      todos: this.#todos()
    })
  }

  /** Down from an empty prompt focuses the pills; ←/→, Enter and Esc/↑ while one holds the keys. */
  #hudKey(key: Key): boolean {
    return this.#hud.key(key, {
      idle: !this.composer.text && !this.composer.browsing && !this.#completion.open,
      pills: this.#pills()
    })
  }

  /** Opens the sheet behind a pill. */
  #openPill(pill: SheetPill) {
    switch (pill) {
      case 'agents':
        openAgents(this)

        break

      case 'shells':
        openBackground(this)

        break

      case 'prs':
        openPrMenu(this)

        break

      case 'goal':

      case 'loop':
        openAutomation(this, pill)

        break
    }
  }

  /** Tells Tern the session's folder when it moved (`hermes -w tern`, a moved workspace): OSC 7. */
  #reportCwd() {
    const cwd = this.info?.cwd

    if (cwd && cwd !== this.#reportedCwd) {
      this.#reportedCwd = cwd
      reportCwd(cwd)
    }
  }

  #connectTimer: NodeJS.Timeout | undefined
  /** Connect cards (by file) this pane saw with an app still waiting. */
  readonly #connectSeen = new Set<string>()
  /** Connect calls that drew no card (a status read, a call with nothing to authorize): never again. */
  readonly #noCard = new WeakSet<object>()

  /**
   * Keeps each connect card current from the file the plugin's watcher writes (links and states),
   * and tells the agent once every app of a card is connected, as the desktop's card settles the call.
   * A settled card never moves again, so the poll runs only while some card is watched.
   */
  #watchConnections() {
    // A new call or a reloaded transcript reads now, not at the next poll.
    clearTimeout(this.#connectTimer)

    const tick = () => {
      this.#connectTimer = undefined
      let open = false

      for (const call of this.transcript.calls(CONNECT_TOOL)) {
        // A running call has no card yet; by its call id alone it would take an earlier call's.
        if (call.connect?.settled || call.status === 'running' || this.#noCard.has(call)) {
          continue
        }

        const next = loadConnect(call)

        if (!next) {
          this.#noCard.add(call)
          continue
        }

        if (JSON.stringify(next) !== JSON.stringify(call.connect)) {
          this.transcript.mutateCall(call, c => (c.connect = next))
          this.changed()
        }

        const seen = next.key ?? call.id

        if (next.targets.some(waiting) && !next.settled) {
          this.#connectSeen.add(seen)
        }

        // Only a card this pane saw waiting: a resumed session's long-settled card stays quiet. Only
        // one pane tells: the claim is the card's.
        if (!next.told && this.#connectSeen.has(seen) && allConnected(next) && (!next.key || claimTold(next.key))) {
          this.transcript.mutateCall(call, () => (next.told = true))
          this.#submit(connectedMessage(next.targets), false)
          this.changed()
        } else if (next.key && !next.settled) {
          open = true
        }
      }

      if (open) {
        this.#connectTimer = setTimeout(tick, POLL_MS)
      }
    }

    tick()
  }

  /** The connect card `ref` names (its file, or its call id when it has none). */
  #connectCall(ref: string) {
    return this.transcript.calls(CONNECT_TOOL).findLast(c => (c.connect?.key ?? c.id) === ref)
  }

  /** A connect card's Continue: tell the agent which apps the user authorized, as the tool asks. */
  #connectContinue(ref: string) {
    const call = this.#connectCall(ref)
    const card = call?.connect

    if (!call || !card || card.told || card.settled) {
      return
    }

    // As on the desktop, Continue settles the card: an app still waiting did not connect.
    this.transcript.mutateCall(call, () => {
      card.told = true
      card.settled = 'continued'
    })

    // Another pane's message already told the agent.
    if (!card.key || claimTold(card.key)) {
      this.#submit(continueMessage(card.targets), false)
    }

    this.changed()
  }

  /** A connect card's Authorize: the app's link in the browser, and its row waits on the browser now. */
  #connectOpen(ref: string, name: string) {
    const call = this.#connectCall(ref)
    const card = call?.connect
    const target = card?.targets.find(t => t.name === name)

    if (!call || !card || !target?.url) {
      return
    }

    openUrl(target.url)
    this.transcript.mutateCall(call, () => (card.opened = [...new Set([...card.opened, name])]))
    this.changed()
  }

  /** A paste that is an image (no text: the clipboard's; one image path: that file); false for text. */
  #pasteImage(text: string): boolean {
    if (!text.trim()) {
      void this.attachClipboardImage(true)

      return true
    }

    const path = imagePathOf(text, this.info?.cwd || this.#launch.cwd)

    if (path) {
      void this.#attachImage(path, basename(path))

      return true
    }

    return false
  }

  /** Attaches the clipboard's image to the next prompt (`quiet`: an empty paste, which may hold none). */
  async attachClipboardImage(quiet: boolean) {
    // The chip shows at once; reading the clipboard and uploading fill it in.
    const slot = this.#startAttaching(`pasted image ${this.#attachments.length + this.#attaching.length + 1}`)

    try {
      const found = await withClipboardImage(async path => {
        await this.#attachImage(path, slot.name, slot)

        return true
      })

      if (!found && !quiet) {
        this.transcript.notice('No image on the clipboard.', 'warning')
      }
    } catch (error) {
      this.transcript.notice(`Could not read the clipboard image: ${errorText(error)}`, 'error')
    } finally {
      this.#endAttaching(slot)
      this.changed()
    }
  }

  /** `/image <path>`: attaches that image file (resolved against the session's folder) to the next prompt. */
  async attachImagePath(raw: string) {
    const path = imagePathOf(raw, this.info?.cwd || this.#launch.cwd)

    if (!path) {
      this.transcript.notice(`Not an image file: ${raw.trim()} (PNG, JPEG, GIF or WebP)`, 'warning')

      return this.changed()
    }

    await this.#attachImage(path, basename(path))
  }

  /** Uploads `path` for the next prompt; its chip says "attaching…" (in `slot`) until it lands or fails. */
  async #attachImage(path: string, name: string, slot = this.#startAttaching(name)) {
    const sid = this.sid

    try {
      if (!sid) {
        this.transcript.notice('Wait for the session to start before attaching an image.', 'warning')

        return
      }

      const image = this.#image(await uploadImage(this.#gw, sid, path, this.#launch.cwd), name)

      // Its chip was removed (✕, Ctrl+C) while it uploaded: the prompt does not take it.
      if (this.#attaching.includes(slot)) {
        this.#attachments.push(image)
      }
    } catch (error) {
      this.transcript.notice(`Could not attach ${name}: ${errorText(error)}`, 'error')
    } finally {
      this.#endAttaching(slot)
      this.changed()
    }
  }

  #startAttaching(name: string): { name: string } {
    const slot = { name }
    this.#attaching.push(slot)
    this.changed()

    return slot
  }

  #endAttaching(slot: { name: string }) {
    this.#attaching = this.#attaching.filter(s => s !== slot)
  }

  /**
   * An uploaded image with its thumbnail: its bytes as a blob, else the gateway's copy where that
   * is on this machine. The bytes are not kept.
   */
  #image({ bytes, ...attachment }: Attachment & { bytes: Buffer }, name: string): Image {
    const size = imageSize(bytes)
    const kb = bytes.length / 1024
    const blob = this.#blob(bytes, attachment.mime)
    const preview = blob ? { blob } : existsSync(attachment.path) ? { path: attachment.path } : undefined
    const caption = [size && `${size.w}×${size.h}`, kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} KB`]

    return { ...attachment, caption: caption.filter(Boolean).join(' · '), name, ...(preview ? { preview } : {}) }
  }

  /** `bytes` sent to Tern as a blob; undefined where it takes none, or for more than a blob holds. */
  #blob(bytes: Uint8Array, mime: string): string | undefined {
    if (!this.#tern.caps.features.includes('blobs')) {
      return undefined
    }

    try {
      return this.#tern.blob(bytes, mime)
    } catch {
      return undefined
    }
  }

  /** Has `call`'s image (a URL's) fetched; its card shows it once it lands. */
  #showImage(call: ToolCall | undefined) {
    if (call) {
      this.media.show(call, () => this.#imageLanded(call))
    }
  }

  #imageLanded(call: ToolCall) {
    this.transcript.touchCall(call)
    this.changed()
  }

  /** Opens or closes the session sidebar (Tern's aside); says why where Tern has none. */
  toggleSidebar() {
    if (!this.#tern.caps.features.includes('aside')) {
      this.transcript.notice('This Tern has no side panel (the aside feature). /changes and /prs still work.', 'warning')
      this.changed()

      return
    }

    // One sheet docks at the edge at a time: the session sidebar takes the PR aside's place.
    if (!this.sidebar.open && this.prAside.open) {
      this.prAside.close()
    }

    this.sidebar.toggle()
  }

  /** Brings node `id` into view (a PR's file, say). */
  reveal(id: string) {
    this.#surface.reveal(id, 'start')
  }

  /** Scrolls the scroll container holding node `id`. */
  scroll(id: string, to: ScrollTo) {
    this.#surface.scroll(id, to)
  }

  /** Docks PR `key` at the pane's right edge, in place of the session sidebar. */
  openPrAside(key: PrKey | undefined) {
    if (!this.#tern.caps.features.includes('aside')) {
      return openPrSheet(this, key)
    }

    if (this.sidebar.open) {
      this.sidebar.toggle()
    }

    this.prAside.show(key)
  }

  /** A subagent ended: the PRs it linked are filed under this conversation (pull_requests.py). */
  agentEnded() {
    this.prs.relink()
  }

  /** Shows subagent `id` beside the chat in a Tern split; its timeline sheet where no split can open. */
  async openAgent(id: string) {
    const a = this.agents.all().find(x => x.id === id)

    if (!a || !this.sid) {
      return
    }

    const cwd = this.info?.cwd || this.#launch.home || '/'

    if (!(await openSidebar(specOf(a, agentName(a), this.sid, this.storedSid), cwd))) {
      openAgents(this, { id, watch: true })
    }
  }

  /** `/help`: the keyboard shortcuts and every command, in the help sheet. */
  openHelp(): Promise<void> {
    return openHelp(this)
  }

  /** Text or images in the composer: Ctrl+C clears them before it interrupts, Ctrl+D never exits over them. */
  #hasDraft(): boolean {
    return Boolean(this.composer.text || this.#attachments.length || this.#attaching.length)
  }

  /** Esc Esc: the draft's text goes to the prompt history (Up brings it back), its images go. */
  #clearDraft() {
    if (this.composer.text.trim()) {
      this.composer.take()
    } else {
      this.composer.set('')
    }

    this.#attachments = []
  }

  #ctrlC() {
    if (this.#hasDraft()) {
      this.composer.set('')
      this.#attachments = []
      this.#attaching = []

      return
    }

    if (this.busy) {
      return this.#interrupt()
    }

    const now = Date.now()

    if (now - this.#exitArmed < EXIT_ARM_MS) {
      return this.quit()
    }

    this.#exitArmed = now
    this.transcript.notice('Press Ctrl+C again to exit.')
  }

  #copy(text: string, id: string) {
    copyToClipboard(text)
    this.#copied = id
    // Node handlers consume their event, so the input loop's re-render never sees this one.
    this.changed()
    clearTimeout(this.#copiedTimer)
    this.#copiedTimer = setTimeout(() => {
      this.#copied = undefined
      this.changed()
    }, COPIED_MS)
  }

  quit(code = 0) {
    markViewer(null, durable(this.#ids))
    this.#done.resolve(code)
  }

  // ── Prompts and commands ───────────────────────────────────────────

  /** Sends the composer's draft, with the pastes it holds. */
  #submitDraft() {
    const pasted = [...this.composer.pasted]

    this.#submit(this.composer.take(), true, this.#busyMode, pasted)
  }

  /**
   * Sends or queues a prompt, or runs a command; `draft`: the user entered it (it takes the draft's
   * images). While a turn runs the prompt goes as `busy` says: the session's busy_input_mode for
   * a typed one; a message the app writes (a connect result) waits behind the turn. `pasted`:
   * the draft's pastes, whose `{!cmd}`s and leading `!` stay as written.
   */
  #submit(raw: string, draft = true, busy: BusyMode = draft ? this.#busyMode : 'queue', pasted: readonly string[] = []) {
    const text = raw.trim()

    // An image still uploading would miss the prompt: the words wait in the composer for it.
    if (draft && this.#attaching.length && !text.startsWith('/')) {
      this.composer.set(raw)
      this.composer.repasted(pasted)
      this.transcript.notice('An image is still attaching. Send again in a moment.', 'warning')

      return
    }

    // Images alone are a prompt: the bubble shows just them (the gateway gets Ink's stand-in words).
    if (!text && !(draft && this.#attachments.length)) {
      return
    }

    if (text.startsWith('/')) {
      void this.#slash(text)

      return
    }

    // `!cmd` runs a shell command now, beside any turn (Ink's shellExec); a pasted one is a prompt.
    if (text.startsWith('!') && text.slice(1).trim() && !pasted.some(p => text.startsWith(p.trim().split('\n')[0]!))) {
      void this.#shell(text.slice(1).trim())

      return
    }

    // The draft's images go with this prompt, whenever it is sent; a message the app writes leaves them.
    const item: Queued = { expand: true, images: draft ? this.#takeImages() : [], pasted, text }

    if (!this.sid || this.#switches.pending) {
      this.queue.push(item)

      return
    }

    if (this.busy) {
      return void this.#busyInput(item, busy)
    }

    // /compress holds the session: the prompt waits behind it (no turn runs, so none to steer).
    if (this.#compacting) {
      return void this.#queueBehind(item)
    }

    this.#send(item)
  }

  /**
   * A prompt entered while a turn runs, as Ink's handleBusyInput: `steer` injects it into the turn,
   * `interrupt` redirects the turn with it, `queue` puts it behind the turn. A steer or redirect
   * carries no images, and one the gateway refuses is queued instead.
   */
  async #busyInput(item: Queued, mode: BusyMode) {
    const sid = this.sid

    if (!sid || mode === 'queue' || item.images.length) {
      return this.#queueBehind(item)
    }

    const ready = await this.#expanded(sid, item)

    if (!ready || sid !== this.sid) {
      return
    }

    const r = await (mode === 'steer' ? steerTurn : redirectTurn)(this.#gw, sid, ready.text)

    if (sid !== this.sid) {
      return
    }

    if (r.ok) {
      this.transcript.steer(item.display ?? item.text)
    } else {
      if (r.error) {
        this.transcript.notice(`${mode === 'steer' ? 'Steer' : 'Redirect'} failed: ${r.error}. Queued instead.`, 'warning')
      }

      this.#queueBehind(item)
    }

    this.changed()
  }

  /** Puts `item` behind the running turn: into the shared gateway's queue at once, else held here. */
  #queueBehind(item: Queued) {
    const sid = this.sid

    if (!this.#gw.isCanonical || !sid || this.#switches.pending) {
      this.queue.push(item)
      this.#drainQueue()

      return this.changed()
    }

    void this.#admit(sid, item)
  }

  /**
   * Admits `item` into session `sid`'s FIFO now (Ink's busy-time admission): crash-durable, and in
   * every viewer's queue. Its bubble waits until the gateway starts it; a refusal puts it back in
   * the composer. `text`: what to send instead of expanding the item again (a re-queued steer).
   */
  async #admit(sid: string, item: Queued, text?: string) {
    const ready = text === undefined ? await this.#expanded(sid, item) : { images: item.images, text }

    if (!ready || sid !== this.sid) {
      return
    }

    const own: OwnAdmission<Admitted> = { display: userText(item.display ?? item.text, item.images), inputId: newInputId(), item: { item, text: ready.text } }
    const attachments = ready.images.map(({ mime, path }) => ({ mime, path }))
    this.#server.admit(own)
    this.changed()

    try {
      const r = await rpc(this.#gw, 'prompt.submit', {
        queued: true,
        session_id: sid,
        submission_id: own.inputId,
        text: ready.text || (attachments.length ? IMAGE_ONLY_PROMPT : ''),
        ...(attachments.length ? { attachments } : {})
      })

      // Only the shared gateway admits into a queue; its receipt names the admission.
      own.admissionId = admissionOf(r)
    } catch (error) {
      this.#server.drop(own)

      if (sid === this.sid) {
        this.transcript.notice(`Not queued: ${errorText(error)}. Your message is back in the composer.`, 'error')
        this.#restore(item)
      }
    }

    this.changed()
  }

  /** `item` with its `{!cmd}`s run (a typed prompt's); undefined when one failed (the prompt is back in the composer). */
  async #expanded(sid: string, item: Queued): Promise<{ images: Image[]; text: string } | undefined> {
    if (!item.expand || !typedCommands(item.text, item.pasted).length) {
      return item
    }

    try {
      return { images: item.images, text: await interpolate(this.#gw, sid, item.text, item.pasted) }
    } catch (error) {
      this.transcript.notice(`Not sent: a {!…} command failed: ${shellError(error)}.`, 'error')
      this.#restore(item)
      this.changed()

      return undefined
    }
  }

  /**
   * Sends `item` now; `queued` marks a drained queue entry (the gateway must queue it, never steer
   * with it). A typed prompt's `{!cmd}`s run first and their output takes their place; `display` is
   * what the transcript shows.
   */
  #send(item: Queued, { display = item.display, queued = false }: { display?: string; queued?: boolean } = {}) {
    const sid = this.sid

    // A session switch in flight: the prompt belongs to the session it adopts.
    if (!sid || this.#switches.pending) {
      this.queue.unshift(item)

      return
    }

    if (item.expand && typedCommands(item.text, item.pasted).length) {
      this.#startBusy('Running {!…}')
      void interpolate(this.#gw, sid, item.text, item.pasted).then(
        text => {
          this.busy = null
          this.#send({ images: item.images, text }, { display: item.text, queued })
        },
        (error: unknown) => {
          // A command that could not run refuses the whole prompt: it goes back to the composer to edit.
          this.busy = null
          this.transcript.notice(`Not sent: a {!…} command failed: ${shellError(error)}.`, 'error')
          this.#restore(item)
          this.#drainQueue()
          this.changed()
        }
      )

      return
    }

    const { images } = item
    const text = item.text || (images.length ? IMAGE_ONLY_PROMPT : '')
    const attachments = images.map(({ mime, path }) => ({ mime, path }))
    const submission = newInputId()
    this.transcript.user({ attachments: userImages(images), text: display?.trim() || item.text })
    // Its bubble is up: the gateway's queued → started for it owes none.
    this.#server.shown(submission)
    this.#startBusy('Working…')
    // The shared gateway admits a prompt by its submission id (a retry with the same id is one turn).
    rpc(this.#gw, 'prompt.submit', {
      session_id: sid,
      submission_id: submission,
      text,
      ...(queued ? { queued } : {}),
      ...(attachments.length ? { attachments } : {})
    }).catch((error: Error) => {
      // Back to the composer, not re-sent: a timeout may come after the gateway admitted it.
      this.transcript.notice(`Not sent: ${error.message}. Your message is back in the composer.`, 'error')
      this.busy = null
      this.#restore(item)
      this.#drainQueue()
      this.changed()
    })
  }

  /** The draft's images, which leave the composer with the prompt that takes them. */
  #takeImages(): Image[] {
    const images = this.#attachments
    this.#attachments = []

    return images
  }

  /** Puts a prompt that did not go back into the composer, before any text there, with its images. */
  #restore({ display, images, pasted = [], text: sent }: Queued) {
    const text = display ?? sent
    this.composer.set(text && this.composer.text ? `${text}\n${this.composer.text}` : text || this.composer.text)
    this.composer.repasted(pasted)
    this.#attachments = [...images, ...this.#attachments]
  }

  /** `!cmd`: runs `command` in the session's folder and shows its output; nothing reaches the model. */
  async #shell(command: string) {
    const sid = this.sid

    if (!sid) {
      this.transcript.notice('Wait for the session to start before running a shell command.', 'warning')

      return this.changed()
    }

    this.transcript.user({ text: `!${command}` })
    this.changed()

    try {
      for (const line of shellLines(await shellExec(this.#gw, sid, command))) {
        this.transcript.notice(line.text, line.failed ? 'warning' : 'info')
      }
    } catch (error) {
      this.transcript.notice(`!${command} did not run: ${shellError(error)}.`, 'error')
    }

    this.changed()
  }

  /** Runs `/name arg`; `resolve`: expand a typed alias or prefix through the catalog first. */
  async #slash(text: string, resolve = true): Promise<void> {
    const [typed = '', ...rest] = text.slice(1).split(/\s+/)
    const name = typed.toLowerCase()
    const arg = rest.join(' ')
    const local = localCommand(name)

    if (local) {
      try {
        const handled = await local.run(this, arg)

        if (local.name === 'reload-skills') {
          this.#catalog.reset()
        }

        if (handled !== false) {
          return this.changed()
        }
      } catch (error) {
        this.transcript.notice(errorText(error), 'error')

        return this.changed()
      }
    }

    // The reply belongs to the session it was typed in: once the view left it, or a switch begun since
    // is in flight, the reply is dropped (Ink's stale()), so a late skill or /plan never sends its prompt
    // to the next session.
    const sid = this.sid
    const generation = this.#switches.generation
    const stale = () => this.sid !== sid || (this.#switches.pending && this.#switches.generation !== generation)

    if (resolve) {
      // Sessionless (starting, or the backend is down), only this frontend's own commands resolve.
      const to = resolveSlashName(name, sid ? await this.#catalog.get(sid) : undefined)

      if (stale()) {
        return
      }

      if (to && 'ambiguous' in to) {
        this.transcript.notice(ambiguousNotice(name, to.ambiguous), 'warning')

        return this.changed()
      }

      if (to) {
        return this.#slash(`/${to.name}${arg ? ` ${arg}` : ''}`, false)
      }
    }

    if (!sid) {
      return
    }

    const title = `/${name}${arg ? ` ${arg}` : ''}`

    try {
      const r = await rpc(this.#gw, 'slash.exec', { command: text.slice(1), session_id: sid })

      if (stale()) {
        return
      }

      await this.#dispatched(r, title, arg)
    } catch (error) {
      if (stale()) {
        return
      }

      // Only "slash.exec does not own this command" (skills, bundles) falls through to command.dispatch;
      // re-dispatching any other refusal could run a mutating command twice.
      if (isUnsupportedCommand(error) || !shouldFallbackToDispatch(error)) {
        this.transcript.notice(describeSlashExecError(name, error), isUnsupportedCommand(error) ? 'warning' : 'error')
      } else {
        try {
          const r = await rpc(this.#gw, 'command.dispatch', { arg, name, session_id: sid })

          if (stale()) {
            return
          }

          await this.#dispatched(r, title, arg)
        } catch (dispatchError) {
          if (stale()) {
            return
          }

          this.transcript.notice(describeSlashExecError(name, dispatchError), 'error')
        }
      }
    }

    this.changed()
  }

  #interrupt() {
    if (!this.sid) {
      return
    }

    if (this.busy) {
      this.busy.label = 'Stopping…'
    }

    interruptTurn(this.#gw, this.sid).catch((error: unknown) => {
      const why = errorText(error)

      // A stale generation means the turn already ended: nothing to say.
      if (this.busy && !why.includes('stale_generation')) {
        this.busy.label = 'Working…'
        this.transcript.notice(`Could not stop the turn: ${why}`, 'error')
        this.changed()
      }
    })
    this.changed()
  }

  /** The gateway-backed commands' view of this app (/steer, /queue, /stop, /tools, /undo, /compress, …). */
  control(): SessionHost {
    const sid = this.sid

    return {
      busy: Boolean(this.busy),
      // A steer that fell back to the queue: steering carries no images.
      canonical: this.#gw.isCanonical,
      enqueue: text => this.#queueBehind({ images: [], text }),
      gw: this.#gw,
      notice: (text, tone) => {
        this.transcript.notice(text, tone)
        this.changed()
      },
      // The shared gateway (the one /branch runs on) answers a resume with one id for both kinds.
      open: async id => {
        await this.resume(id)

        return durable(this.#ids) === id
      },
      panel: (title, text) => {
        this.transcript.panel(title, text)
        this.changed()
      },
      compressing: state => {
        if (state === 'start') {
          this.transcript.compacting({ before: this.usage?.context_used || undefined, manual: true })
        } else if (state === 'none') {
          this.transcript.uncompact()
        } else {
          this.transcript.compacted(Date.now(), state)
        }

        this.#setCompacting(state === 'start')

        this.changed()
      },
      queued: this.#queuedCount(),
      reload: async () => {
        if (sid && this.sid === sid) {
          await this.#resume(sid)
        }
      },
      send: text => this.#send({ images: [], text }),
      sid,
      stale: () => this.sid !== sid,
      steered: text => {
        this.transcript.steer(text)
        this.changed()
      },
      // /queue: behind the turn whatever busy_input_mode says.
      submit: text => this.#submit(text, true, 'queue')
    }
  }

  /** A compaction started or ended; prompts held behind one with no turn running go once it ends. */
  #setCompacting(on: boolean) {
    this.#compacting = on ? (this.#compacting ?? { since: {}, startedAt: Date.now() }) : undefined

    if (!on) {
      this.#drainQueue()
    }
  }

  /** Gives the compactions seen here their summaries from the store, `delay` ms from now. */
  #summarize(delay = 0) {
    const sid = this.sid

    if (!this.transcript.unsummarized) {
      return
    }

    this.#timers.timeout(() => {
      const stored = this.info?.stored_session_id || this.storedSid

      if (this.sid === sid && stored && this.transcript.unsummarized) {
        this.transcript.summarize(storedCompactions(stored))
        this.changed()
      }
    }, delay)
  }

  #startBusy(label: string) {
    this.busy = { label, since: {}, startedAt: Date.now() }
    this.changed()
  }

  // ── Sessions ───────────────────────────────────────────────────────

  /** The first session: HERMES_TUI_RESUME's, else a new one; then the launcher's startup image, if any. */
  async #bootstrap() {
    const resume = this.#launch.resume

    try {
      await (resume ? this.resume(storedSessionId(resume)) : this.newSession())
    } catch (error) {
      this.transcript.notice(
        `Could not start a session: ${errorText(error)}`,
        'error'
      )
      this.changed()

      return
    }

    if (this.sid && this.#startupImage) {
      await this.#attachStartupImage(this.sid)
    }
  }

  /** `hermes -q … --image …`: attaches the image to the first session, then lets the startup query go. */
  async #attachStartupImage(sid: string) {
    const path = this.#startupImage

    try {
      if (this.#gw.isCanonical) {
        const image = this.#image(await uploadImage(this.#gw, sid, path, this.#launch.cwd), basename(path))
        // The startup query waits at the queue's head for this image.
        const images = this.queue[0]?.images ?? this.#attachments
        images.push(image)
      } else {
        await rpc(this.#gw, 'image.attach', { path, session_id: sid })
      }
    } catch (error) {
      this.transcript.notice(
        `Could not attach ${path}: ${errorText(error)}`,
        'warning'
      )
    }

    this.#startupImage = ''
    this.#drainQueue()
    this.changed()
  }

  /** After a reconnect (or a replay gap): resumes the shown session under `id` (its runtime id or subscription died). */
  async #reattach(id: DurableSessionId, notice = 'Reconnected to the agent backend.') {
    try {
      if (await this.#resume(id)) {
        this.transcript.notice(notice)
      }
    } catch (error) {
      this.transcript.notice(
        `Could not reattach the session: ${errorText(error)}`,
        'error'
      )
    }

    this.changed()
  }

  /** Closes the open session and starts a fresh one with an empty transcript, named `title` if given. */
  async newSession(title?: string) {
    if (this.#busySwitch()) {
      return
    }

    const previous = this.sid
    const token = this.#switches.begin()

    try {
      const setup = await rpc(this.#gw, 'setup.status', {})

      if (!this.#switches.current(token)) {
        return
      }

      if (setup?.provider_configured === false) {
        this.transcript.notice('No model provider is configured. Run `hermes setup`, then start again.', 'warning')

        return
      }

      const cwd = this.#launch.sessionCwd

      // The shared gateway takes the launch flags (`hermes tern -m … --yolo -s …`) as the session's creation policy.
      const r: Snapshot = await rpc(
        this.#gw,
        'session.create',
        this.#gw.isCanonical
          ? { ...localCreationOptions(), ...(cwd ? { cwd } : {}) }
          : { cols: this.#tern.caps.cols, ...(cwd ? { cwd } : {}) }
      )

      if (!this.#switches.current(token)) {
        // A later switch won; nothing will ever show this session.
        this.#views.superseded(r)

        return
      }

      this.transcript.clear()
      this.transcript.push({ id: this.transcript.id('w'), kind: 'welcome' })
      this.#adopt(r)

      // Only now: a failed create leaves the view on the session it still receives.
      if (previous && previous !== r.session_id) {
        void this.#views.leave(previous, 'tui_close')
      }
    } finally {
      this.#settle(token)
    }

    if (title && this.sid) {
      await this.#title.rename(this.sid, title)
    }
  }

  /** Refuses a session switch while a turn runs (its queue and prompts belong to this session); true when refused. */
  #busySwitch(): boolean {
    if (!this.busy) {
      return false
    }

    this.transcript.notice('Wait for the current turn to finish (or press Esc twice) before switching sessions.', 'warning')
    this.changed()

    return true
  }

  /** Resumes stored session `id`: its history replaces the transcript, and the session it leaves is closed. */
  async resume(id: StoredSessionId) {
    if (this.#busySwitch()) {
      return
    }

    const previous = this.sid
    const r = await this.#resume(id)

    if (r && previous && previous !== r.session_id) {
      void this.#views.leave(previous, 'tui_close')
    }
  }

  /**
   * Resumes and adopts session `id` (its stored id, or a runtime id when none is known); undefined
   * when a later switch superseded this one.
   */
  async #resume(id: DurableSessionId): Promise<Snapshot | undefined> {
    const token = this.#switches.begin()
    // Frames for `id` that beat the snapshot wait, then replay only what the snapshot lacks.
    const hold = this.#gw.holdAttach(id)
    let snapshot: Snapshot | undefined

    try {
      const detaching = this.#views.detaching(id)

      if (detaching) {
        // A detach that lands after this attach would drop the subscription the attach reuses.
        await detaching

        if (!this.#switches.current(token)) {
          return undefined
        }
      }

      const r: Snapshot = await rpc(this.#gw, 'session.resume', { cols: this.#tern.caps.cols, session_id: id })

      if (!this.#switches.current(token)) {
        this.#views.superseded(r)

        return undefined
      }

      this.transcript.clear()
      this.transcript.push({ id: this.transcript.id('w'), kind: 'welcome' })
      this.#adopt(r)
      snapshot = r
      // An approval or question already waiting on the session opens its sheet. A sheet from before
      // the reattach may have been answered or pruned meanwhile (its settled event is not replayed).
      this.#dropPrompts(key => key.startsWith(`prompt:${sharedPromptId('')}`))
      this.#gw.hydrateSharedPrompts(r)

      return r
    } finally {
      this.#gw.settleAttach(hold, snapshot)
      this.#settle(token)
    }
  }

  #adopt(r: Snapshot) {
    const ref = this.#views.adopt(r)

    if (ref.live !== this.sid) {
      // The last session's approvals and questions are not this one's (a resume hydrates its own after).
      this.#dropPrompts(() => true)
      this.transcript.forgetCompactions()
      this.#busyMode = 'queue'
    }

    // Read on every adopt: a reconnect may land on a gateway whose config changed.
    void this.#readBusyMode(ref.live)

    // The session's own queue, from the snapshot (a reattach's rows of this pane become read-only rows).
    this.#server.reset(pendingRows(r.info))

    const previousStored = this.#ids.stored
    this.#ids = ref
    showThoughts({ gw: this.#gw, notice: (text, tone) => this.notice(text, tone), settings: this.#settings }, ref.live)
    // This pane shows the session now: the plugin's Python half sends its connect results here as a card.
    markViewer(durable(ref), previousStored)
    writeActiveSessionFile(durable(ref))
    this.info = r.info ?? this.info
    this.usage = r.info?.usage ?? null
    // Another session: its own name (or none yet) on the tab.
    this.#title.adopt(typeof r.info?.title === 'string' ? r.info.title : undefined)
    this.#reportCwd()
    // A resumed session may be mid-turn: Esc Esc stops it and new prompts go as busy_input_mode says.
    this.busy = busyFrom(r)
    // The last session's notices and status lines are not this one's.
    this.#notices.reset()
    this.#compacting = undefined
    this.#lastStatusNote = undefined
    this.transcript.usageBase(r.info?.usage ?? undefined)

    if (r.messages?.length) {
      // The history leaves the compactions out; the store says where they were.
      this.transcript.load(r.messages, storedCompactions(durable(ref)))
      this.agents.scan()
      this.media.showAll(this.transcript.entries, call => this.#imageLanded(call))
    }

    // The new session's processes and PRs (and none of the last one's), and its open connect cards.
    this.processes.poke()
    this.#watchConnections()
    this.prs.adopt()
    this.automation.adopt(ref.live)

    if (r.inflight) {
      this.transcript.inflight(r.inflight, this.busy?.startedAt)
    }

    this.changed()
  }

  /** Acts on a command's dispatch envelope from outside a typed command (a goal or loop sheet's button). */
  runDispatch(raw: unknown, title: string): Promise<void> {
    return this.#dispatched(raw, title, '')
  }

  /** Acts on a slash.exec / command.dispatch answer: output, a skill or message to send, an alias or a prefill. */
  /** A prompt a slash command made (a skill, a `send`): while a turn runs it takes the busy path a typed one does. */
  #prompt(item: Queued) {
    if (this.busy) {
      return void this.#busyInput(item, this.#busyMode)
    }

    if (this.#compacting) {
      return void this.#queueBehind(item)
    }

    this.#send(item)
  }

  async #dispatched(raw: unknown, title: string, arg: string) {
    const d = parseCommandDispatch(raw)
    const legacy = (raw ?? {}) as { output?: string; warning?: string }

    if (legacy.warning) {
      this.transcript.notice(legacy.warning, 'warning')
    }

    if (!d) {
      if (legacy.output?.trim()) {
        this.transcript.panel(title, legacy.output)
      }

      return
    }

    switch (d.type) {
      case 'exec':

      case 'plugin':
        if (d.output?.trim()) {
          this.transcript.panel(title, d.output)
        }

        return

      case 'alias':
        return this.#slash(`/${d.target}${arg ? ` ${arg}` : ''}`)

      case 'skill':
        // `message` is the expanded skill body for the model; the transcript shows the invocation.
        return d.message?.trim()
          ? this.#prompt({ display: d.display || title, images: this.#takeImages(), text: d.message })
          : this.transcript.notice(`${title}: the skill sent no message`, 'error')

      case 'send':
        if (d.notice?.trim()) {
          this.transcript.notice(d.notice)
        }

        return d.message?.trim() ? this.#prompt({ display: d.display, images: this.#takeImages(), text: d.message }) : undefined

      case 'prefill':
        if (d.notice?.trim()) {
          this.transcript.notice(d.notice)
        }

        this.composer.set(d.message)
    }
  }

  /** Ends switch `token`; once none is in flight, held requests for the adopted session open and the queue drains. */
  #settle(token: number) {
    this.#switches.end(token)

    if (this.#switches.pending) {
      return
    }

    this.#views.release(this.sid)
    const held = this.#heldRequests
    this.#heldRequests = []

    for (const req of held) {
      this.#onRequest(req)
    }

    this.#drainQueue()
    this.changed()
  }

  // ── Gateway ────────────────────────────────────────────────────────

  #onGatewayEvent(ev: AnyGatewayEvent) {
    // Another session's traffic (one being closed, or left by a switch) never reaches this transcript.
    if (!ownsEvent(this.sid, ev)) {
      return
    }

    const t = this.transcript

    switch (ev.type) {
      case 'gateway.ready':
        this.#reconnect.ready()
        this.#theme.skin(ev.payload?.skin)
        // A reconnect's ready reattaches the shown session; only a sessionless app bootstraps.
        void (this.#ids.stored ? this.#reattach(this.#ids.stored) : this.#bootstrap())

        break

      case 'skin.changed':
        this.#theme.skin(ev.payload)

        break

      // The goal and loop line: every set, pause, resume, stop, wakeup and judged turn.
      case 'session.control.update':
        this.automation.apply(ev.session_id ?? this.sid, ev.payload?.control)

        return

      case 'gateway.reconnecting':
        this.#reconnect.redialing(ev.payload?.attempt ?? 1, ev.payload?.delay_ms ?? 0)

        break

      case 'session.info': {
        const cwd = this.info?.cwd
        // The shared owner's idle fanout carries only pending/revision/generation: merge, never replace.
        this.info = ev.payload ? { ...this.info, ...ev.payload } : this.info
        this.usage = ev.payload?.usage ?? this.usage
        t.contextUsed(this.usage?.context_used ?? 0)

        // A queued prompt the gateway started gets its bubble now, after the reply it waited for.
        for (const started of this.#server.update(pendingRows(ev.payload))) {
          const own = started.own?.item.item
          t.started(own ? (own.display ?? own.text) : started.text, undefined, own ? userImages(own.images) : [])
        }

        this.#title.set(typeof ev.payload?.title === 'string' ? ev.payload.title : undefined)

        // Another folder: another branch, maybe another PR.
        if (this.info?.cwd && this.info.cwd !== cwd) {
          this.prs.poke()
          this.#reportCwd()
        }

        break
      }

      case 'session.usage': {
        // The shared owner sends its counters at the top level; older gateways nest them.
        const tick = usageFromTick(ev.payload)
        this.usage = tick ? { ...this.usage, ...tick } : this.usage
        t.contextUsed(this.usage?.context_used ?? 0)
        const counters = usageCounters(ev.payload)

        if (counters) {
          t.usageTick(counters.counters, counters.tps)
        }

        break
      }

      case 'session.title':
        this.#title.set(ev.payload?.title)

        break

      // A title set by /title or Hermes' auto-titler reaches viewers only as a changed session list.
      case 'sessions.changed':
        this.#title.read()

        return

      // The view fell behind and the owner retired its subscription (the socket is fine, so no
      // reconnect re-attaches it): a fresh resume brings the snapshot and a new subscription.
      case 'session.replay_gap':
        if (isLive(this.#ids) && ev.session_id === this.#ids.live) {
          void this.#reattach(durable(this.#ids), 'Reloaded the session: this view fell behind its events.')
        }

        return

      case 'message.start':
        if (!this.busy) {
          this.#startBusy('Working…')
        }

        t.start()

        // A delegation's completion turn carries its model text: each task's outcome, which a log
        // this process cannot read (a remote gateway) never told.
        if (ev.payload?.display_kind === 'async_delegation_complete' && ev.payload.text) {
          this.agents.settle(ev.payload.text)
        }

        break

      case 'message.delta':
        t.text(ev.payload?.text ?? '')
        this.#label('Writing…')

        break

      case 'reasoning.delta':
        t.reasoning(ev.payload?.text ?? '')
        this.#label('Thinking…')

        break

      case 'reasoning.available':
        t.reasoningBlock(ev.payload?.text ?? '')

        break

      // Mixture-of-Agents: each reference model's answer, then the aggregator's turn.
      case 'moa.reference':
        if (ev.payload) {
          t.reference(moaReferenceLabel(ev.payload.label || 'reference', ev.payload.index, ev.payload.count), ev.payload.text ?? '')
        }

        break

      case 'moa.progress':

      case 'moa.phase':

      case 'moa.aggregating':
        this.#label(moaLabel(ev) ?? '')

        break

      case 'thinking.delta':
        this.#label(kaomojiLabel(ev.payload?.text ?? ''))

        break

      case 'message.interim':
        t.interim(ev.payload?.text ?? '', { alreadyStreamed: Boolean(ev.payload?.already_streamed) })

        break

      case 'tool.generating':
        this.#label(ev.payload?.name ? preparingLabel(ev.payload.name) : 'Preparing a tool…')

        break

      case 'tool.start':
        if (ev.payload) {
          t.toolStart(ev.payload)
          // The call as its step reads (a bridged or connector call as its app), not its wire name.
          const call = t.call(toolCallId(ev.payload.tool_id))
          this.#label(call ? busyLabel(call) : `Running ${ev.payload.name}…`)
          // vision_analyze names its image up front.
          this.#showImage(call)
        }

        break

      case 'tool.complete':
        if (ev.payload) {
          t.toolComplete(ev.payload)
          this.#showImage(t.call(toolCallId(ev.payload.tool_id)))
          // A dispatched delegation: its agents' rows start following the owner.
          this.agents.scan()

          if (ev.payload.name === 'delegate_task') {
            // Its subagents (a foreground call's have ended) may have linked PRs.
            this.prs.relink()
          }

          if (LINK_TOOLS.has(ev.payload.name)) {
            const call = this.transcript.calls(ev.payload.name).at(-1)

            if (call) {
              this.prs.onCall(call)
            }
          }

          if (['patch', 'terminal', 'write_file', 'execute_code'].includes(ev.payload.name)) {
            this.sidebar.poke()
          }

          if (ev.payload.name === CONNECT_TOOL) {
            this.#watchConnections()
          }

          if (ev.payload.name === 'terminal') {
            // Maybe a background start: its card's live line begins now, not at the next idle poll.
            this.processes.poke()
          }
        }

        break

      case 'agent.terminal.output':
        if (ev.payload?.process_id) {
          this.processes.output(ev.payload.process_id, ev.payload.chunk ?? '')
        }

        return

      case 'todo.updated':
        t.todos(ev.payload?.todos ?? [])

        break

      case 'subagent.spawn_requested':

      case 'subagent.start':

      case 'subagent.thinking':

      case 'subagent.tool':

      case 'subagent.progress':

      case 'subagent.complete':
        if (ev.payload) {
          t.subagent(ev.type, ev.payload)
        }

        if (ev.type === 'subagent.complete') {
          this.agentEnded()
        }

        break

      case 'message.complete':
        // prompt.cancel settles a withdrawn queued row with a completion of its own.
        if (this.#server.settlesQueuedRow(ev.payload)) {
          return
        }

        t.complete(ev.payload ?? {})
        this.busy = null
        this.#compacting = undefined
        // A compaction Hermes aborted sends no done edge; one that committed has its summary stored now.
        t.uncompact(true)
        this.#summarize()
        this.#drainQueue()
        // The turn may have pushed a branch, opened a PR or changed files.
        this.prs.poke()
        this.sidebar.poke()

        break

      case 'status.update': {
        // Lifecycle lines (retries, fallbacks) label the working line; warnings, compaction and goal
        // verdicts are transcript lines.
        const effect = statusEffect(ev.payload, this.#lastStatusNote)

        if (effect.compacting !== undefined) {
          this.#setCompacting(effect.compacting)
        }

        if (effect.compacting) {
          t.compacting({ before: effect.tokens?.before ?? (this.usage?.context_used || undefined) })
        } else if (effect.compacting === false) {
          t.compacted(Date.now(), effect.tokens)
          // The store has the summary once the compaction commits (a moment after its done edge).
          this.#summarize(1500)
        }

        if (effect.label) {
          this.#label(effect.label, true)
        }

        if (effect.notice) {
          this.#lastStatusNote = effect.note ?? this.#lastStatusNote
          t.notice(effect.notice.text, effect.notice.tone)
        }

        break
      }

      case 'notification.show': {
        const p = ev.payload

        // A /login step (its link and code, then the result) is read and clicked, so it goes in the transcript.
        if (p && isLoginNotice(p)) {
          if (p.text?.trim()) {
            t.panel('/login', p.text)
          }

          break
        }

        if (p) {
          this.#notices.show(p)
        }

        break
      }

      case 'notification.clear':
        this.#notices.clear(ev.payload?.key)

        break

      // What the background self-improvement review saved to memory or skills.
      case 'review.summary': {
        const text = String(ev.payload?.text ?? '').trim()

        if (!text) {
          return
        }

        t.notice(text)

        break
      }

      case 'notice':
        t.notice(ev.payload?.message ?? '')

        break

      case 'error':
        t.notice(ev.payload?.message ?? 'error', 'error')

        break

      case 'gateway.start_timeout':
        // The client keeps waiting for ready; the stderr lines say why it is slow (wrong python, a missing dependency).
        for (const note of slowStartNotes(ev.payload?.stderr_tail)) {
          t.notice(note.text, note.tone)
        }

        break

      case 'gateway.protocol_error': {
        const note = protocolNote(ev.payload?.preview, this.#protocolWarned)
        this.#protocolWarned = true

        if (!note) {
          return
        }

        t.notice(note.text, note.tone)

        break
      }

      case 'background.complete':

      case 'btw.complete':
        if (ev.payload && 'text' in ev.payload && typeof ev.payload.text === 'string' && ev.payload.text.trim()) {
          // Titled as Ink labels them: the task id /bg named, the question /btw asked.
          const question = 'question' in ev.payload && typeof ev.payload.question === 'string' ? ev.payload.question.trim() : ''
          const task = 'task_id' in ev.payload && typeof ev.payload.task_id === 'string' ? ` ${ev.payload.task_id}` : ''

          t.panel(
            ev.type === 'btw.complete' ? `/btw${question ? ` ${question}` : ''}` : `Background task${task}`,
            ev.payload.text
          )
        }

        break

      case 'request.cancel': {
        const id = ev.payload?.id
        const notice = promptTimeoutNotice(ev.payload?.method, ev.payload?.reason)
        // Only for a card this window still shows (or holds): an answered one needs no line.
        const shown =
          this.#heldRequests.some(r => r.id === id) || this.overlays.some(o => o.key === `prompt:${id}`)

        this.#heldRequests = this.#heldRequests.filter(r => r.id !== id)
        this.#dropPrompts(key => key === `prompt:${id}`)

        if (notice && shown) {
          t.notice(notice, 'warning')
        }

        break
      }

      case 'approval.request':

      case 'clarify.request': {
        const req = sharedPromptRequest(ev, this.#gw, message => {
          t.notice(message, 'warning')
          this.changed()
        })

        if (req) {
          this.#onRequest(req)
        }

        break
      }

      case 'approval.settled':

      case 'clarify.settled':
        // Answered here or by another viewer: the sheet goes either way.
        this.#dropPrompts(key => key === `prompt:${sharedPromptId(ev.payload?.prompt_id)}`)

        break

      case 'approval.cancelled':
        this.#dropPrompts(key => ev.payload?.request_ids.includes(this.#approvalIds.get(key) ?? '') ?? false)

        break

      default:
        return
    }

    this.changed()
  }

  #onRequest(req: ServerRequest) {
    const route = this.#switches.route(this.sid, req.params.session_id)

    if (route === 'hold') {
      this.#heldRequests.push(req)

      return
    }

    // Another session's prompt: it settles when that session closes.
    if (route === 'drop') {
      return
    }

    const overlay = promptOverlay(this, req)

    if (!overlay) {
      req.fail(-32601, `${req.method} is not supported by the Tern frontend`)

      return
    }

    this.open(overlay)

    if (req.method === 'approval' && typeof req.params.request_id === 'string') {
      this.#approvalIds.set(overlay.key, req.params.request_id)
    }
  }

  /** Closes the prompt overlays whose key `cancelled` picks (the gateway withdrew their requests). */
  #dropPrompts(cancelled: (key: string) => boolean) {
    for (const o of [...this.overlays]) {
      if (o.key.startsWith('prompt:') && cancelled(o.key)) {
        this.close(o)
      }
    }
  }

  /** Whose colors the surface wears (`/theme`). */
  get theme(): ThemeMode {
    return this.#theme.mode
  }

  /** Switches the theme mode now and keeps it for the next launch. */
  setTheme(mode: ThemeMode) {
    this.#theme.set(mode)
    this.changed()
  }

  /** Relabels the working line; the stream's labels wait while the context is compacted (`status`: a status line's own). */
  #label(label: string, status = false) {
    if (this.busy && label && (status || !this.#compacting)) {
      this.busy.label = label
    }
  }

  /** Sets the reasoning effort for this session, or also as the default of every new one (session/effort.ts). */
  setEffort(value: string, scope: 'global' | 'session'): Promise<void> {
    return applyEffort(this, value, scope)
  }

  /** Prompts waiting behind the turn: this pane's own queue, then the shared gateway's. */
  #queuedCount(): number {
    return this.queue.length + this.#server.queued().length
  }

  /** The dock's queued rows, in #queuedCount's order, with what each one's Edit and Steer can do. */
  #queuedRows(): QueuedRow[] {
    const steer = Boolean(this.busy)

    return [
      ...this.queue.map(q => ({ edit: true, steer, text: userText(q.display ?? q.text, q.images) })),
      ...this.#server.queued().map((q): QueuedRow => {
        if (!q.own) {
          return { note: q.row?.status === 'unknown' ? 'unknown' : 'elsewhere', text: internalNotice(q.text) ?? q.text }
        }

        // Withdrawing it needs the gateway's id for it: until prompt.submit answers it is on its way.
        return q.own.admissionId
          ? { edit: true, steer: steer && !q.own.item.item.images.length, text: q.text }
          : { pending: true, text: q.text }
      })
    ]
  }

  /** The shared gateway's queued row at dock index `index`, if this pane can act on it. */
  #serverQueued(index: number): ServerQueued<Admitted> | undefined {
    const q = this.#server.queued()[index - this.queue.length]

    return q?.own?.admissionId ? q : undefined
  }

  /**
   * Takes this pane's admission out of the gateway's queue (prompt.cancel); true once withdrawn,
   * false when it started meanwhile (it runs as its own turn) or the gateway refused.
   */
  async #withdraw(sid: string, q: ServerQueued<Admitted>): Promise<boolean> {
    const own = q.own!
    const admissionId = own.admissionId!
    // Its `cancelled` completion can come before the reply.
    this.#server.withdrawn(admissionId)

    try {
      const r = await rpc(this.#gw, 'prompt.cancel', { admission_id: admissionId, session_id: sid })

      if (r?.status !== 'terminal') {
        return false
      }
    } catch (error) {
      this.transcript.notice(`Could not take the prompt out of the queue: ${errorText(error)}`, 'error')
      this.changed()

      return false
    }

    this.#server.drop(own)

    return true
  }

  /** Alt+Up / a queued row's Edit: queued prompt `index` (the oldest by default) back into the composer. */
  #dequeue(index = 0) {
    if (index < this.queue.length) {
      const [next] = this.queue.splice(index, 1)

      if (next) {
        this.#restore(next)
        this.changed()
      }

      return
    }

    const sid = this.sid
    const q = this.#serverQueued(index)

    if (!sid || !q) {
      return
    }

    void this.#withdraw(sid, q).then(out => {
      if (out && sid === this.sid) {
        this.#restore(q.own!.item.item)
      }

      this.changed()
    })
  }

  /** Alt+Enter / a queued row's Steer: injects queued prompt `index` into the running turn instead of waiting for it to end. */
  #steerQueued(index: number) {
    const sid = this.sid

    if (!this.busy || !sid) {
      return
    }

    if (index >= this.queue.length) {
      return void this.#steerServerQueued(sid, index)
    }

    const item = this.queue[index]

    if (!item) {
      return
    }

    // A steer is text only: a prompt with images waits for its own turn.
    if (item.images.length) {
      this.transcript.notice('A queued prompt with images cannot steer the turn. It stays queued.', 'warning')

      return this.changed()
    }

    const { text } = item
    this.queue.splice(index, 1)
    this.changed()
    void steerTurn(this.#gw, sid, text).then(r => {
      if (r.ok) {
        this.transcript.steer(text)
      } else {
        this.queue.splice(index, 0, item)
        this.transcript.notice(
          r.error
            ? `Steer failed: ${r.error}. It stays queued.`
            : 'The turn ended before the steer landed. It will send as the next prompt.',
          'warning'
        )
        this.#drainQueue()
      }

      this.changed()
    })
  }

  /**
   * A Steer on a row in the gateway's queue: withdrawn from it, then steered into the turn; a steer
   * that does not land goes back into the queue, at its end.
   */
  async #steerServerQueued(sid: string, index: number) {
    const q = this.#serverQueued(index)

    if (!q) {
      return
    }

    const { item, text } = q.own!.item

    if (item.images.length) {
      this.transcript.notice('A queued prompt with images cannot steer the turn. It stays queued.', 'warning')

      return this.changed()
    }

    if (!(await this.#withdraw(sid, q)) || sid !== this.sid) {
      return
    }

    const r = await steerTurn(this.#gw, sid, text)

    if (sid !== this.sid) {
      return
    }

    if (r.ok) {
      this.transcript.steer(item.display ?? item.text)
    } else {
      this.transcript.notice(
        r.error ? `Steer failed: ${r.error}. Queued again, at the end.` : 'The turn ended before the steer landed. Queued again.',
        'warning'
      )
      void this.#admit(sid, item, text)
    }

    this.changed()
  }

  /** Reads session `sid`'s busy_input_mode; an older gateway without it leaves Enter queueing (the TUI default). */
  async #readBusyMode(sid: string) {
    try {
      const r = await rpc(this.#gw, 'config.get', { key: 'busy', session_id: sid })

      if (sid === this.sid) {
        this.#busyMode = busyModeOf(r?.value)
      }
    } catch {
      // Keeps `queue`.
    }
  }

  /** Sends the oldest queued prompt once the session is adopted and idle (no turn, switch or startup image pending). */
  #drainQueue() {
    if (this.busy || this.#compacting || !this.sid || this.#switches.pending || this.#startupImage) {
      return
    }

    const next = this.queue.shift()

    if (next) {
      this.#send(next, { queued: true })
    }
  }

  // ── View ───────────────────────────────────────────────────────────

  #render() {
    if (this.#surface.closed) {
      return
    }

    const now = Date.now()
    const info = this.info
    const usage = this.usage
    const backend = info?.version && info.version !== 'unknown' ? `v${info.version}` : ''

    const cx = {
      copied: this.#copied,
      copy: (text: string, id: string) => this.#copy(text, id),
      now,
      welcome: { ...this.#welcome, version: this.#welcome.version || backend }
    }

    // A pill that left (its last process aged out) hands the keys back.
    this.#hud.prune(this.#pills(now))
    const recent = this.processes.recent(now)
    const exited = recent.filter(p => !processRuns(p))
    const used = usage?.context_used ?? 0
    const max = usage?.context_max ?? 0
    const modal = this.overlays.at(-1)?.modal === true

    // Every composer change (keys, native edits and undo, submits, queue edits) ends in a render: refresh here.
    if (!modal) {
      this.#completion.update(this.composer)
    }

    this.#surface.render({
      dock: dockNodes({
        branch: info?.branch ?? '',
        busy: this.busy ?? undefined,
        compacting: this.busy ? undefined : this.#compacting,
        composer: this.composer,
        context: max > 0 ? { max, used } : undefined,
        cost: usage?.cost_usd ?? undefined,
        cwd: info?.cwd ? homeTilde(info.cwd, this.#launch.home) : '',
        effort: info?.reasoning_effort ?? '',
        effortWire: info?.reasoning_effort_wire || undefined,
        fast: fastTier(info),
        reasons: capsOf(info)?.reasoning,
        automation: {
          goal: this.automation.goal,
          loop: this.automation.loop(now),
          loopOwner: this.automation.loopSnapshot,
          onGoal: () => openAutomation(this, 'goal'),
          onLoop: () => openAutomation(this, 'loop')
        },
        reconnecting: this.#reconnect.redial,
        ghost: modal ? '' : this.#completion.ghost,
        inputId: INPUT_ID,
        model: info?.model ?? '',
        now,
        onEdit: ev => {
          this.composer.edit(ev)
          this.changed()
        },
        onEffort: () => cycleEffort(this),
        onEffortMenu: {
          'choose-effort': () => openEffortPicker(this),
          'save-effort-as-default': () => void this.setEffort(this.info?.reasoning_effort || DEFAULT_EFFORT, 'global')
        },
        onInterrupt: () => this.#interrupt(),
        onModel: () => openModelPicker(this),
        onQueueEdit: i => this.#dequeue(i),
        onQueueSteer: this.busy ? i => this.#steerQueued(i) : undefined,
        onSend: ev => {
          this.#submit(ev.text)
          this.changed()
        },
        onSubmit: () => {
          this.#submitDraft()
          this.changed()
        },
        onUndo: () => {
          this.composer.undo()
          this.changed()
        },
        agents: { onOpen: () => openAgents(this), running: this.agents.running().length },
        prs: prsPill(this.prs.entries(), () => openPrMenu(this)),
        attachments: [
          ...this.#attachments.map((a, i) => ({
            caption: a.caption,
            image: a.preview,
            label: a.name,
            onRemove: () => {
              this.#attachments.splice(i, 1)
              this.changed()
            }
          })),
          ...this.#attaching.map(slot => ({
            label: slot.name,
            onRemove: () => {
              this.#endAttaching(slot)
              this.changed()
            },
            pending: true
          }))
        ],
        status: {
          compressions: typeof usage?.compressions === 'number' ? usage.compressions : undefined,
          notice: this.#notices.current(now),
          title: this.#title.text || undefined,
          tokens: typeof usage?.total === 'number' ? usage.total : undefined
        },
        todos: (() => {
          const list = this.#todos()

          return list
            ? {
                list,
                onToggle: () => this.#hud.toggleTodos(),
                open: this.#hud.todosOpen
              }
            : undefined
        })(),
        focused: modal ? undefined : this.#hud.focused,
        shells: {
          charts: recent.flatMap(p => (p.chart && processRuns(p) ? [{ process: p, view: p.chart }] : [])),
          exited: exited.length,
          onOpen: () => openBackground(this),
          running: recent.length - exited.length,
          // The roster puts the newest exit first.
          tone: exited[0] ? processTone(exited[0].status) : 'muted'
        },
        rates: {
          cache: typeof usage?.cache_hit_pct === 'number' ? usage.cache_hit_pct : undefined,
          tps: typeof usage?.avg_tps === 'number' && usage.avg_tps > 0 ? usage.avg_tps : undefined
        },
        placeholder: 'Ask Hermes — / commands · @ files',
        queued: this.#queuedRows(),
        ready: this.sid !== null
      }),
      layer: [
        ...(this.#tern.caps.features.includes('aside')
          ? [this.prAside.open ? this.prAside.node('layer.prs') : this.sidebar.node('layer.sidebar')].filter(n => n !== null)
          : []),
        ...this.overlays.map(o => o.node(`layer.${o.key}`)),
        ...(modal ? [] : this.#completion.nodes(INPUT_ID))
      ],
      main: this.transcript.entries.map(e => entryNode(e, `main.${e.id}`, cx))
    })

    // The top overlay's field holds the caret; a modal sheet without one takes it from the composer.
    const top = this.overlays.at(-1)
    const focus = top?.focus ? top.focus(`layer.${top.key}`) : top?.modal || this.#hud.focused ? null : INPUT_ID

    this.#surface.follow(focus)
  }
}

/** A prompt's bubble: its text, and how many images went with it. */
/** A queued prompt's dock line: its words and how many images it carries. */
function userText(text: string, images: readonly unknown[]): string {
  const count = images.length ? `📎 ${images.length} image${images.length === 1 ? '' : 's'}` : ''

  return [text, count].filter(Boolean).join('\n\n')
}

/** A sent prompt's images, drawn as thumbnails in its bubble. */
function userImages(images: readonly Image[]): UserAttachment[] {
  return images.map(i => ({ kind: 'image', name: i.name, ...(i.preview ? { source: i.preview } : {}) }))
}

/** `( •_•)>⌐■-■ cogitating...` → `Cogitating…`: hermes's kawaii status without the face. */
function kaomojiLabel(text: string): string {
  const word = text.match(/([A-Za-z][A-Za-z ]*[A-Za-z])\.{2,}\s*$/)?.[1]

  return word ? `${word.charAt(0).toUpperCase()}${word.slice(1)}…` : ''
}

