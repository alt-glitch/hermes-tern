// The app: one inline Tern surface (role `omp.session`, so Tern's chat styles
// apply) over one tui_gateway session. Gateway events fold into the
// transcript, keys go to the top overlay or the composer, and every change
// schedules one render of the whole view; the SDK diffs it into frame ops.

import { appendFileSync } from 'node:fs'

import type { Usage } from '@hermes/shared/gateway-events'
import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import { parseCommandDispatch } from '@hermes/shared/slash'
import type { Key, ScrollTo, Session, TspEvent } from '@stencil-hq/tern'
import { describeSlashExecError, isUnsupportedCommand, shouldFallbackToDispatch } from '@tui/app/userMessages.js'
import { usageFromTick } from '@tui/domain/usage.js'
import type { GatewayClient } from '@tui/gatewayClient.js'
import type { AnyGatewayEvent } from '@tui/gatewayTypes.js'
import type { SessionInfo } from '@tui/types.js'

import logo from '../assets/logo.png'

import { agentName, Agents } from './agents/store.js'
import type { ChatPorts, SessionView } from './app/ports.js'
import { Automation } from './automation.js'
import { Hud, pills, type Pill, type SheetPill, todos } from './chrome/hud.js'
import { isLoginNotice, NoticeStrip } from './chrome/notices.js'
import { Reconnect } from './chrome/reconnect.js'
import { Theme } from './chrome/theme.js'
import { copyToClipboard } from './clipboard.js'
import { type LaunchEnv, readLaunchEnv } from './config/env.js'
import { localCommand } from './commands.js'
import { Composer } from './composer.js'
import { ConnectWatcher } from './connections/watcher.js'
import { interruptTurn } from './controlCommands.js'
import { Disposables } from './core/disposables.js'
import { errorText } from './core/errors.js'
import {
  durable,
  entryId,
  type LiveSessionId,
  liveSessionId,
  type PrKey,
  type StoredSessionId,
  storedSessionId,
  toolCallId
} from './core/ids.js'
import { RenderScheduler } from './core/scheduler.js'
import { Attachments } from './draft/attachments.js'
import { fastTier } from './fast.js'
import { ownsEvent } from './flow.js'
import { protocolNote, slowStartNotes } from './backendNotes.js'
import { moaLabel, moaReferenceLabel } from './moa.js'
import type { Overlay } from './overlay.js'
import { writeActiveSessionFile } from './hermes/activeSessionFile.js'
import { Media } from './media.js'
import type { NoticeEntry, ToolCall } from './model.js'
import { shellError, shellExec, shellLines } from './hermes/shell.js'
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
import { CONNECT_TOOL, markViewer } from './connections.js'
import { LINK_TOOLS } from './github/links.js'
import { PullRequests } from './github/store.js'
import { Cron } from './processes/cron.js'
import { PrAside } from './prs/aside.js'
import { PromptSheets } from './prompts/sheets.js'
import { adoptSteps } from './session/adopt.js'
import { applyEffort, cycleEffort, DEFAULT_EFFORT } from './session/effort.js'
import { SessionLifecycle } from './session/lifecycle.js'
import { SessionState } from './session/state.js'
import { showThoughts } from './session/thoughts.js'
import { SessionTitle } from './session/title.js'
import { Sidebar } from './sidebar.js'
import type { SessionHost } from './sessionCommands.js'
import { ambiguousNotice, CommandCatalog, resolveSlashName } from './slashResolve.js'
import { statusEffect } from './status.js'
import { isRunning as processRuns, Processes, processTone } from './processes/store.js'
import { hermesAuthor } from './processes/widgets/author.js'
import { chartMemory } from './processes/widgets/memory.js'
import { fileSettings, type SettingsSource, type ThemeMode } from './settings.js'
import { Activity, type Busy } from './turn/activity.js'
import { PromptQueue } from './turn/queue.js'
import { IMAGE_ONLY_PROMPT, type Prompt, shownText, userImages } from './turn/prompt.js'
import { type GateState, gateDrain, PromptRouter } from './turn/router.js'
import { type BusyMode, busyModeOf } from './turn/serverQueue.js'
import { INPUT_ID, SurfaceHost } from './surface/host.js'
import { runInput } from './surface/input.js'
import { reportCwd } from './surface/osc.js'
import { Transcript } from './transcript.js'
import { storedCompactions } from './compaction.js'
import { dockNodes } from './view/dock.js'
import { homeTilde } from './view/format.js'
import { entryNode } from './view/transcript.js'
import { rpc } from './wire/rpc.js'
import { pendingRows, usageCounters } from './wire/schemas.js'
import { busyLabel, preparingLabel } from './workLog.js'
import { openSidebar, specOf } from './watch/spec.js'
import { randomTip, type WelcomeContext } from './view/welcome.js'

const EXIT_ARM_MS = 1500
/** Two Esc presses within this window are a double Esc (Ink's DOUBLE_ESC_MS). */
const DOUBLE_ESC_MS = 500
/** How long a prompt's Copy button reads Copied. */
const COPIED_MS = 1500
/** How long quitting waits for the sessions to detach. */
const QUIT_DETACH_MS = 1500

/** Runs the Tern frontend until the user quits; resolves the exit code. */
export class App implements ChatPorts {
  /** The open session's ids, info, usage and busy-input mode; every write renders. */
  readonly #state = new SessionState(() => this.changed())
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
    sid: () => durable(this.#state.ref)
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
  /** The session as the ports read it: its ids and `info`, live. */
  readonly session: SessionView = this.#state
  /** The working line's busy state and the compaction phase: their one owner. */
  readonly #activity = new Activity()
  /** The prompts waiting behind the turn: held here, and the shared gateway's queue for this session. */
  readonly #queue: PromptQueue
  /** Where each prompt goes: sent, the busy path, behind the turn, or held. */
  readonly #router: PromptRouter
  readonly #tern: Session
  readonly #gw: GatewayClient
  readonly #completion: Completion
  /** `commands.catalog`, for resolving a typed alias or prefix (`/hea` → /heartbeat). */
  readonly #catalog: CommandCatalog
  readonly #welcome: WelcomeContext
  readonly #launch: LaunchEnv
  #surface!: SurfaceHost
  readonly #renders = new RenderScheduler(() => this.#render())
  /** Timers with no field of their own (a compaction's summary read, the quit's detach wait). */
  readonly #timers = new Disposables()
  #exitArmed = 0
  #lastEsc = 0
  #done = Promise.withResolvers<number>()
  /** Which session the pane shows and how it switches: views, held requests, the adopt steps. */
  readonly #life: SessionLifecycle
  /** The prompt sheets the gateway's questions opened, and their approval-queue ids. */
  readonly #sheets: PromptSheets = new PromptSheets(this)
  /** The draft's images, those still uploading, and the launcher's startup image. */
  readonly #attachments: Attachments
  /** The connect cards, kept current from the plugin's files. */
  readonly #connect: ConnectWatcher = new ConnectWatcher({
    changed: () => this.changed(),
    openUrl,
    tell: text => this.#submit(text, false),
    transcript: this.transcript
  })
  /** The folder last reported to Tern by OSC 7. */
  #reportedCwd: string | undefined
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
  /** The status warning shown last, so a repeated one stays one line. */
  #lastStatusNote: string | undefined

  /** `launch` and `settings` are what entry.ts read once at startup; unset, each reads its default. */
  constructor(tern: Session, gw: GatewayClient, version: string, { launch = readLaunchEnv(), settings = fileSettings() }: { launch?: LaunchEnv; settings?: SettingsSource } = {}) {
    this.#tern = tern
    this.#gw = gw
    this.#launch = launch
    this.#attachments = new Attachments(
      {
        attachToHead: image => this.#queue.attachToHead(image),
        blob: (bytes, mime) => this.#blob(bytes, mime),
        changed: () => this.changed(),
        cwd: () => this.info?.cwd || launch.cwd,
        gw,
        launchCwd: launch.cwd,
        note: (text, tone) => this.transcript.notice(text, tone),
        sid: () => this.sid
      },
      { startup: launch.image }
    )
    this.#queue = new PromptQueue({
      busy: () => Boolean(this.busy),
      canDrain: () => gateDrain(this.#gates()),
      changed: () => this.changed(),
      expanded: (sid, prompt) => this.#router.expanded(sid, prompt),
      gw,
      restore: prompt => this.#restore(prompt),
      send: prompt => this.#router.send(prompt, { queued: true }),
      ticket: () => this.#state.ticket(),
      transcript: this.transcript
    })
    this.#router = new PromptRouter({
      activity: this.#activity,
      changed: () => this.changed(),
      gates: () => this.#gates(),
      gw,
      queue: this.#queue,
      restore: prompt => this.#restore(prompt),
      ticket: () => this.#state.ticket(),
      transcript: this.transcript
    })
    this.#life = new SessionLifecycle(
      {
        attachStartup: sid => this.#attachStartupImage(sid),
        awaitingStartup: () => this.#attachments.awaitingStartup,
        busy: () => Boolean(this.busy),
        changed: () => this.changed(),
        cols: () => tern.caps.cols,
        drain: () => this.#drainQueue(),
        gw,
        launch,
        rename: (sid, title) => this.#title.rename(sid, title),
        request: req => this.#onRequest(req),
        sheets: this.#sheets,
        state: this.#state,
        transcript: this.transcript
      },
      adoptSteps({
        activity: this.#activity,
        agents: this.agents,
        automation: this.automation,
        changed: () => this.changed(),
        connect: this.#connect,
        forgetStatusNote: () => {
          this.#lastStatusNote = undefined
        },
        imageLanded: call => this.#imageLanded(call),
        markViewer,
        media: this.media,
        notices: this.#notices,
        processes: this.processes,
        prs: this.prs,
        queue: this.#queue,
        readBusyMode: () => void this.#readBusyMode(),
        reportCwd: () => this.#reportCwd(),
        sheets: this.#sheets,
        showThoughts: sid => showThoughts({ gw, notice: (text, tone) => this.notice(text, tone), settings }, sid),
        state: this.#state,
        title: this.#title,
        transcript: this.transcript,
        writeActiveSession: writeActiveSessionFile
      })
    )
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
    return this.#state.ref.live
  }

  /** Sets the runtime id, keeping the stored one (tests arrange a session this way). */
  set sid(id: string | null) {
    this.#state.ref = { live: id === null ? null : liveSessionId(id), stored: this.#state.ref.stored }
  }

  /** The gateway's session.info, merged (tests arrange it; SessionState owns it). */
  get info(): SessionInfo | null {
    return this.#state.info
  }

  set info(info: SessionInfo | null) {
    this.#state.info = info
  }

  /** The session's token and context counters. */
  get usage(): Usage | null {
    return this.#state.usage
  }

  set usage(usage: Usage | null) {
    this.#state.usage = usage
  }

  /** The running turn (or a send's `{!cmd}`s), null when idle; tests arrange it, and Activity owns it. */
  get busy(): Busy | null {
    return this.#activity.busy
  }

  set busy(busy: Busy | null) {
    this.#activity.set(busy)
  }

  /** Prompts held here until they can be sent (tests read and arrange it). */
  get queue(): Prompt[] {
    return this.#queue.held
  }

  set queue(prompts: Prompt[]) {
    this.#queue.held = prompts
  }

  /** The stored (database) id of the open session: what `session.list` rows are keyed by. */
  get storedSid(): StoredSessionId | null {
    return this.#state.ref.stored
  }

  /** Sets the stored id, keeping the runtime one (tests arrange a session this way). */
  set storedSid(id: string | null) {
    this.#state.ref = { live: this.#state.ref.live, stored: id === null ? null : storedSessionId(id) }
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

    if (query || this.#attachments.awaitingStartup) {
      this.#queue.hold({ images: [], kind: 'app', text: query || IMAGE_ONLY_PROMPT })
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

      // The runtime session died with the process: prompts queue until the next gateway.ready
      // reattaches, and nothing can answer the held requests now.
      this.#life.lost()
      this.#activity.endBusy()
      // Nothing can answer the sheets either; the reattach re-opens the questions still pending.
      this.#sheets.dropAll()
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
      this.#life.leaveAll('tui_shutdown'),
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
    clearTimeout(this.#copiedTimer)
    this.#timers.dispose()
    this.#connect.dispose()
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
      this.#sheets.closed(overlay)
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

    if (key.alt && key.name === 'up' && this.#queue.count()) {
      return this.#queue.dequeue(0)
    }

    if (key.alt && key.name === 'enter' && this.busy && this.#queue.count() && !this.composer.text) {
      return this.#queue.steer(0)
    }

    if (key.ctrl && key.name === 'd' && !this.#hasDraft()) {
      return this.quit()
    }

    // An image: a paste with no text (what a terminal sends for a clipboard image), a pasted or
    // dropped image path, or Ctrl+V.
    if (key.name === 'paste' && this.#attachments.paste(key.text ?? '')) {
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
      return this.#connect.continue(ev.value)
    }

    // `<card>:<app>`: the card names the row, as call ids repeat.
    if (ev.ev === 'action' && ev.act === 'connect-open' && ev.value) {
      const at = ev.value.lastIndexOf(':')

      return this.#connect.open(ev.value.slice(0, at), ev.value.slice(at + 1))
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

  /** Attaches the clipboard's image to the next prompt (`quiet`: an empty paste, which may hold none). */
  attachClipboardImage(quiet: boolean): Promise<void> {
    return this.#attachments.fromClipboard(quiet)
  }

  /** `/image <path>`: attaches that image file (resolved against the session's folder) to the next prompt. */
  attachImagePath(raw: string): Promise<void> {
    return this.#attachments.fromPath(raw)
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
    return Boolean(this.composer.text || this.#attachments.any)
  }

  /** Esc Esc: the draft's text goes to the prompt history (Up brings it back), its images go. */
  #clearDraft() {
    if (this.composer.text.trim()) {
      this.composer.take()
    } else {
      this.composer.set('')
    }

    // Its images go; one still uploading lands after.
    this.#attachments.clear()
  }

  #ctrlC() {
    if (this.#hasDraft()) {
      this.composer.set('')
      this.#attachments.clearAll()

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
    markViewer(null, durable(this.#state.ref))
    this.#done.resolve(code)
  }

  // ── Prompts and commands ───────────────────────────────────────────

  /** Sends the composer's draft, with the pastes it holds. */
  #submitDraft() {
    const pasted = [...this.composer.pasted]

    this.#submit(this.composer.take(), true, this.#state.busyMode, pasted)
  }

  /**
   * Sends or queues a prompt, or runs a command; `draft`: the user entered it (it takes the draft's
   * images). While a turn runs the prompt goes as `busy` says: the session's busy_input_mode for
   * a typed one; a message the app writes (a connect result) waits behind the turn. `pasted`:
   * the draft's pastes, whose `{!cmd}`s and leading `!` stay as written.
   */
  #submit(raw: string, draft = true, busy: BusyMode = draft ? this.#state.busyMode : 'queue', pasted: readonly string[] = []) {
    const text = raw.trim()

    // An image still uploading would miss the prompt: the words wait in the composer for it.
    if (draft && this.#attachments.uploading && !text.startsWith('/')) {
      this.composer.set(raw)
      this.composer.repasted(pasted)
      this.transcript.notice('An image is still attaching. Send again in a moment.', 'warning')

      return
    }

    // Images alone are a prompt: the bubble shows just them (the gateway gets Ink's stand-in words).
    if (!text && !(draft && this.#attachments.items.length)) {
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
    this.#router.route({ images: draft ? this.#attachments.take() : [], kind: 'typed', pasted, text }, busy, 'typed')
  }

  /** What the router's gates read: the session, the switch in flight, the turn, the compaction and the startup image. */
  #gates(): GateState {
    return {
      awaitingStartup: this.#attachments.awaitingStartup,
      busy: this.#activity.busy !== null,
      canonical: this.#gw.isCanonical,
      compacting: this.#activity.compacting !== undefined,
      sid: this.sid,
      switching: this.#life.switching
    }
  }

  /** Puts a prompt that did not go back into the composer, before any text there, with its images. */
  #restore(prompt: Prompt) {
    const text = shownText(prompt)
    this.composer.set(text && this.composer.text ? `${text}\n${this.composer.text}` : text || this.composer.text)
    this.composer.repasted(prompt.kind === 'typed' ? prompt.pasted : [])
    this.#attachments.restore(prompt.images)
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
    const ticket = this.#life.replyTicket()
    const { sid } = ticket
    const stale = () => !ticket.isCurrent()

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

    // Last write wins: the stream's next label replaces this one.
    this.#activity.relabel('Stopping…', { status: true })

    interruptTurn(this.#gw, this.sid).catch((error: unknown) => {
      const why = errorText(error)

      // A stale generation means the turn already ended: nothing to say.
      if (this.busy && !why.includes('stale_generation')) {
        // 'Working…', not the label it replaced: whatever the turn shows now.
        this.#activity.relabel('Working…', { status: true })
        this.transcript.notice(`Could not stop the turn: ${why}`, 'error')
        this.changed()
      }
    })
    this.changed()
  }

  /** The gateway-backed commands' view of this app (/steer, /queue, /stop, /tools, /undo, /compress, …). */
  control(): SessionHost {
    const ticket = this.#state.ticket()
    const { sid } = ticket

    return {
      busy: Boolean(this.busy),
      // A steer that fell back to the queue: steering carries no images.
      canonical: this.#gw.isCanonical,
      enqueue: text => this.#router.behind({ images: [], kind: 'app', text }),
      gw: this.#gw,
      notice: (text, tone) => {
        this.transcript.notice(text, tone)
        this.changed()
      },
      // The shared gateway (the one /branch runs on) answers a resume with one id for both kinds.
      open: async id => {
        await this.resume(id)

        return durable(this.#state.ref) === id
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

        this.#setCompacting(state === 'start', { manual: true })

        this.changed()
      },
      queued: this.#queue.count(),
      reload: async () => {
        if (sid && ticket.isCurrent()) {
          await this.#life.reload(sid)
        }
      },
      send: text => this.#router.send({ images: [], kind: 'app', text }),
      sid,
      stale: () => !ticket.isCurrent(),
      steered: text => {
        this.transcript.steer(text)
        this.changed()
      },
      // /queue: behind the turn whatever busy_input_mode says.
      submit: text => this.#submit(text, true, 'queue')
    }
  }

  /**
   * A compaction started (`manual`: /compress's) or ended. While one runs the working line says so
   * until its done edge, and with no turn running the dock shows it and prompts queue behind it;
   * those go once it ends.
   */
  #setCompacting(on: boolean, { manual = false }: { manual?: boolean } = {}) {
    if (on) {
      this.#activity.startCompaction({ manual })
    } else {
      this.#activity.endCompaction()
      this.#drainQueue()
    }
  }

  /** Gives the compactions seen here their summaries from the store, `delay` ms from now. */
  #summarize(delay = 0) {
    const ticket = this.#state.ticket()

    if (!this.transcript.unsummarized) {
      return
    }

    this.#timers.timeout(() => {
      const stored = this.info?.stored_session_id || this.storedSid

      if (ticket.isCurrent() && stored && this.transcript.unsummarized) {
        this.transcript.summarize(storedCompactions(stored))
        this.changed()
      }
    }, delay)
  }

  // ── Sessions ───────────────────────────────────────────────────────

  /** `hermes -q … --image …`: attaches the image to the first session, then lets the startup query go. */
  async #attachStartupImage(sid: string) {
    await this.#attachments.attachStartup(sid)
    this.#drainQueue()
    this.changed()
  }

  /** Closes the open session and starts a fresh one with an empty transcript, named `title` if given. */
  newSession(title?: string): Promise<void> {
    return this.#life.newSession(title)
  }

  /** Resumes stored session `id`: its history replaces the transcript, and the session it leaves is closed. */
  resume(id: StoredSessionId): Promise<void> {
    return this.#life.resume(id)
  }

  /** Acts on a command's dispatch envelope from outside a typed command (a goal or loop sheet's button). */
  runDispatch(raw: unknown, title: string): Promise<void> {
    return this.#dispatched(raw, title, '')
  }

  /** Acts on a slash.exec / command.dispatch answer: output, a skill or message to send, an alias or a prefill. */
  /** A prompt a slash command made (a skill, a `send`): while a turn runs it takes the busy path a typed one does. */
  #prompt(item: Prompt) {
    this.#router.route(item, this.#state.busyMode, 'command')
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
          ? this.#prompt({ display: d.display || title, images: this.#attachments.take(), kind: 'command', text: d.message })
          : this.transcript.notice(`${title}: the skill sent no message`, 'error')

      case 'send':
        if (d.notice?.trim()) {
          this.transcript.notice(d.notice)
        }

        return d.message?.trim() ? this.#prompt({ display: d.display, images: this.#attachments.take(), kind: 'command', text: d.message }) : undefined

      case 'prefill':
        if (d.notice?.trim()) {
          this.transcript.notice(d.notice)
        }

        this.composer.set(d.message)
    }
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
        this.#life.ready()

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
        for (const started of this.#queue.server.update(pendingRows(ev.payload))) {
          const own = started.own?.item.prompt
          t.started(own ? shownText(own) : started.text, undefined, own ? userImages(own.images) : [])
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

      // The view fell behind: a fresh resume brings the snapshot and a new subscription.
      case 'session.replay_gap':
        this.#life.fellBehind(ev.session_id)

        return

      case 'message.start':
        if (!this.busy) {
          this.#activity.startBusy('Working…')
          this.changed()
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
        this.#activity.relabel('Writing…')

        break

      case 'reasoning.delta':
        t.reasoning(ev.payload?.text ?? '')
        this.#activity.relabel('Thinking…')

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
        this.#activity.relabel(moaLabel(ev) ?? '')

        break

      case 'thinking.delta':
        this.#activity.relabel(kaomojiLabel(ev.payload?.text ?? ''))

        break

      case 'message.interim':
        t.interim(ev.payload?.text ?? '', { alreadyStreamed: Boolean(ev.payload?.already_streamed) })

        break

      case 'tool.generating':
        this.#activity.relabel(ev.payload?.name ? preparingLabel(ev.payload.name) : 'Preparing a tool…')

        break

      case 'tool.start':
        if (ev.payload) {
          t.toolStart(ev.payload)
          // The call as its step reads (a bridged or connector call as its app), not its wire name.
          const call = t.call(toolCallId(ev.payload.tool_id))
          this.#activity.relabel(call ? busyLabel(call) : `Running ${ev.payload.name}…`)
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
            this.#connect.watch()
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
        if (this.#queue.server.settlesQueuedRow(ev.payload)) {
          return
        }

        t.complete(ev.payload ?? {})
        this.#activity.endBusy()
        this.#activity.endCompaction()
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
          this.#activity.relabel(effect.label, { status: true })
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
        const held = this.#life.unhold(id)
        const shown = held || this.#sheets.shows(id)

        this.#sheets.drop(id)

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
        this.#sheets.drop(sharedPromptId(ev.payload?.prompt_id))

        break

      case 'approval.cancelled':
        this.#sheets.dropByApproval(ev.payload?.request_ids)

        break

      default:
        return
    }

    this.changed()
  }

  #onRequest(req: ServerRequest) {
    // Held while a switch is in flight, or another session's prompt (it settles when that session closes).
    if (this.#life.route(req) !== 'show') {
      return
    }

    const overlay = promptOverlay(this, req)

    if (!overlay) {
      req.fail(-32601, `${req.method} is not supported by the Tern frontend`)

      return
    }

    this.#sheets.open(overlay, req)
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

  /** Sets the reasoning effort for this session, or also as the default of every new one (session/effort.ts). */
  setEffort(value: string, scope: 'global' | 'session'): Promise<void> {
    return applyEffort(this, value, scope)
  }

  /** Reads the shown session's busy_input_mode; an older gateway without it leaves Enter queueing (the TUI default). */
  async #readBusyMode() {
    const ticket = this.#state.ticket()

    if (!ticket.sid) {
      return
    }

    try {
      const r = await rpc(this.#gw, 'config.get', { key: 'busy', session_id: ticket.sid })

      if (ticket.isCurrent()) {
        this.#state.busyMode = busyModeOf(r?.value)
      }
    } catch {
      // Keeps `queue`.
    }
  }

  /** Sends the oldest queued prompt once the session is adopted and idle (no turn, switch or startup image pending). */
  #drainQueue() {
    this.#queue.drain()
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
        compacting: this.busy ? undefined : this.#activity.compacting,
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
        onQueueEdit: i => this.#queue.dequeue(i),
        onQueueSteer: this.busy ? i => this.#queue.steer(i) : undefined,
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
        attachments: this.#attachments.chips(),
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
        queued: this.#queue.rows(),
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

/** `( •_•)>⌐■-■ cogitating...` → `Cogitating…`: hermes's kawaii status without the face. */
function kaomojiLabel(text: string): string {
  const word = text.match(/([A-Za-z][A-Za-z ]*[A-Za-z])\.{2,}\s*$/)?.[1]

  return word ? `${word.charAt(0).toUpperCase()}${word.slice(1)}…` : ''
}

