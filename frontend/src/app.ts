// The app: one inline Tern surface (role `omp.session`, so Tern's chat styles
// apply) over one tui_gateway session. Gateway events fold into the
// transcript, keys go to the top overlay or the composer, and every change
// schedules one render of the whole view; the SDK diffs it into frame ops.

import type { Usage } from '@hermes/shared/gateway-events'
import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import type { Key, ScrollTo, Session } from '@stencil-hq/tern'
import type { GatewayClient } from '@tui/gatewayClient.js'
import type { AnyGatewayEvent } from '@tui/gatewayTypes.js'
import type { SessionInfo } from '@tui/types.js'

import logo from '../assets/logo.png'

import { agentName, Agents } from './agents/store.js'
import type { ChatPorts, SessionView } from './app/ports.js'
import { Automation } from './automation.js'
import { Hud, pills, type Pill, type SheetPill, todos } from './chrome/hud.js'
import { NoticeStrip } from './chrome/notices.js'
import { Reconnect } from './chrome/reconnect.js'
import { Theme } from './chrome/theme.js'
import { copyToClipboard } from './clipboard.js'
import { type LaunchEnv, readLaunchEnv } from './config/env.js'
import { sessionHost, type SessionHostCx } from './commands/host.js'
import { dispatched, runSlash, type SlashCx } from './commands/slash.js'
import { Composer } from './composer.js'
import { ConnectWatcher } from './connections/watcher.js'
import { interruptTurn } from './controlCommands.js'
import { Disposables } from './core/disposables.js'
import { errorText } from './core/errors.js'
import { durable, entryId, type LiveSessionId, liveSessionId, type PrKey, type StoredSessionId, storedSessionId } from './core/ids.js'
import { RenderScheduler } from './core/scheduler.js'
import { Attachments } from './draft/attachments.js'
import { type KeyCx, onKey, type Presses } from './draft/keys.js'
import { fastTier } from './fast.js'
import { dispatcher, type Outcome } from './gateway/dispatch.js'
import { type EventLog, eventLog } from './gateway/eventLog.js'
import type { Warned } from './gateway/handlers/chrome.js'
import type { Overlay } from './overlay.js'
import { writeActiveSessionFile } from './hermes/activeSessionFile.js'
import { Media } from './media.js'
import type { NoticeEntry, ToolCall } from './model.js'
import { shellError, shellExec, shellLines } from './hermes/shell.js'
import { openAgents } from './overlays/agents.js'
import { openAutomation } from './overlays/automation.js'
import { openBackground } from './overlays/background.js'
import { Completion } from './overlays/completion.js'
import { openModelPicker } from './overlays/models.js'
import { openEffortPicker } from './overlays/effort.js'
import { openHelp } from './overlays/help.js'
import { capsOf } from './modelCaps.js'
import { promptOverlay } from './overlays/prompts.js'
import { openPrMenu, openPrSheet, openUrl, prsPill } from './overlays/pullRequests.js'
import { markViewer } from './connections.js'
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
import { CommandCatalog } from './slashResolve.js'
import { isRunning as processRuns, Processes, processTone } from './processes/store.js'
import { hermesAuthor } from './processes/widgets/author.js'
import { chartMemory } from './processes/widgets/memory.js'
import { fileSettings, type SettingsSource, type ThemeMode } from './settings.js'
import { Activity, type Busy } from './turn/activity.js'
import { PromptQueue } from './turn/queue.js'
import { IMAGE_ONLY_PROMPT, type Prompt, shownText } from './turn/prompt.js'
import { type GateState, gateDrain, PromptRouter } from './turn/router.js'
import { type BusyMode, busyModeOf } from './turn/serverQueue.js'
import { type ActionCx, onTernEvent } from './surface/actions.js'
import { INPUT_ID, SurfaceHost } from './surface/host.js'
import { runInput } from './surface/input.js'
import { reportCwd } from './surface/osc.js'
import { Transcript } from './transcript.js'
import { storedCompactions } from './compaction.js'
import { dockNodes } from './view/dock.js'
import { homeTilde } from './view/format.js'
import { entryNode } from './view/transcript.js'
import { rpc } from './wire/rpc.js'
import { openSidebar, specOf } from './watch/spec.js'
import { randomTip, type WelcomeContext } from './view/welcome.js'

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
  readonly #welcome: WelcomeContext
  readonly #launch: LaunchEnv
  #surface!: SurfaceHost
  readonly #renders = new RenderScheduler(() => this.#render())
  /** Timers with no field of their own (a compaction's summary read, the quit's detach wait). */
  readonly #timers = new Disposables()
  /** The last lone Esc and the first Ctrl+C of a quit, for the double presses. */
  readonly #presses: Presses = { esc: 0, exit: 0 }
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
  /** The backend warnings shown already (stray output, the last status warning), so each stays one line. */
  readonly #warned: Warned = { protocol: false, status: undefined }
  /** The gateway's keyed notices (credits, a slow start); the newest rides the status strip. */
  readonly #notices = new NoticeStrip(this)
  /** The development tap (HERMES_TERN_EVENT_LOG): every event and server request, as JSON lines. */
  readonly #log: EventLog
  /** What each gateway event does to the pane (gateway/handlers/*), and whether it renders. */
  readonly #dispatch: (ev: AnyGatewayEvent) => Outcome
  /** What the key rules (draft/keys.ts) reach. */
  readonly #keys: KeyCx
  /** What the Tern actions (surface/actions.ts) reach. */
  readonly #actions: ActionCx
  /** What a slash command reaches (commands/slash.ts). */
  readonly #slash: SlashCx
  /** What the control and session commands' host is made from (commands/host.ts). */
  readonly #host: SessionHostCx

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
          this.#warned.status = undefined
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
    this.#welcome = {
      tip: randomTip(launch.pythonSrcRoot),
      version: version && version !== 'unknown' ? `v${version}` : ''
    }
    this.#log = eventLog(launch.eventLog)
    this.#dispatch = dispatcher(
      {
        activity: this.#activity,
        agents: this.agents,
        automation: this.automation,
        changed: () => this.changed(),
        connect: this.#connect,
        drain: () => this.#drainQueue(),
        gw,
        life: this.#life,
        notices: this.#notices,
        processes: this.processes,
        prs: this.prs,
        queue: this.#queue,
        reconnect: this.#reconnect,
        reportCwd: () => this.#reportCwd(),
        request: req => this.#onRequest(req),
        session: this.#state,
        setCompacting: on => this.#setCompacting(on),
        sheets: this.#sheets,
        showImage: call => this.#showImage(call),
        sid: () => this.sid,
        sidebar: this.sidebar,
        summarize: delay => this.#summarize(delay),
        theme: this.#theme,
        title: this.#title,
        transcript: this.transcript,
        warned: this.#warned
      },
      type => this.#log.unknown(type)
    )
    this.#keys = {
      attachClipboardImage: () => void this.attachClipboardImage(false),
      attachments: this.#attachments,
      busy: () => Boolean(this.busy),
      close: overlay => this.close(overlay),
      completion: this.#completion,
      composer: this.composer,
      cycleEffort: () => cycleEffort(this),
      hud: key => this.#hudKey(key),
      interrupt: () => this.#interrupt(),
      now: Date.now,
      openAgents: () => openAgents(this),
      openBackground: () => openBackground(this),
      openPrs: () => openPrMenu(this),
      presses: this.#presses,
      queue: this.#queue,
      quit: () => this.quit(),
      submitDraft: () => this.#submitDraft(),
      toggleSidebar: () => this.toggleSidebar(),
      transcript: this.transcript
    }
    this.#actions = {
      connect: this.#connect,
      focusComposer: () => {
        this.#hud.release()
        this.#surface.focus(INPUT_ID)
      },
      modal: () => this.overlays.at(-1)?.modal === true,
      openAgent: id => void this.openAgent(id),
      openProcess: id => openBackground(this, id),
      openUrl
    }
    this.#slash = {
      attachments: this.#attachments,
      catalog: new CommandCatalog(gw),
      changed: () => this.changed(),
      composer: this.composer,
      gw,
      host: this,
      life: this.#life,
      prompt: item => this.#router.route(item, this.#state.busyMode, 'command'),
      transcript: this.transcript
    }
    this.#host = {
      activity: this.#activity,
      changed: () => this.changed(),
      gw,
      life: this.#life,
      queue: this.#queue,
      router: this.#router,
      setCompacting: (on, opts) => this.#setCompacting(on, opts),
      state: this.#state,
      submit: text => this.#submit(text, true, 'queue'),
      transcript: this.transcript
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

    this.#gw.on('event', (ev: AnyGatewayEvent) => {
      this.#log.event(ev)

      if (this.#dispatch(ev) === 'render') {
        this.changed()
      }
    })
    this.#gw.on('request', (req: ServerRequest) => {
      this.#log.request(req)
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
      onEvent: event => onTernEvent(event, this.#actions),
      onKey: key => onKey(key, this.#keys, this.overlays.at(-1))
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
      void runSlash(text, this.#slash)

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
    return sessionHost(this.#host)
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
    return dispatched(raw, this.#slash, { arg: '', title })
  }

  // ── Gateway ────────────────────────────────────────────────────────

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
