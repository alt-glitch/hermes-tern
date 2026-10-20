// The app: one inline Tern surface (role `omp.session`, so Tern's chat styles
// apply) over one tui_gateway session. Gateway events fold into the
// transcript, keys go to the top overlay or the composer, and every change
// schedules one frame of the whole view (app/frame.ts); the SDK diffs it into
// frame ops. App makes the stores, in the order they depend on each other,
// and the actions over them (app/actions.ts), and lends them as ChatPorts.

import type { ScrollTo, Session } from '@stencil-hq/tern'
import type { GatewayClient } from '@tui/gatewayClient.js'
import type { SessionInfo } from '@tui/types.js'

import logo from '../assets/logo.png'

import { Agents } from './agents/store.js'
import { AppActions } from './app/actions.js'
import { drawFrame, type FrameCx } from './app/frame.js'
import type { ChatPorts, SessionView } from './app/ports.js'
import { Automation } from './automation.js'
import { Hud } from './chrome/hud.js'
import { NoticeStrip } from './chrome/notices.js'
import { Reconnect } from './chrome/reconnect.js'
import { Theme } from './chrome/theme.js'
import { type LaunchEnv, readLaunchEnv } from './config/env.js'
import { sessionHost } from './commands/host.js'
import { dispatched } from './commands/slash.js'
import { Composer } from './composer.js'
import { markViewer } from './connections.js'
import { ConnectWatcher } from './connections/watcher.js'
import { Disposables } from './core/disposables.js'
import { errorText } from './core/errors.js'
import { durable, entryId, type LiveSessionId, liveSessionId, type PrKey, type StoredSessionId, storedSessionId } from './core/ids.js'
import { RenderScheduler } from './core/scheduler.js'
import { Attachments } from './draft/attachments.js'
import { onKey, type Presses } from './draft/keys.js'
import { followGateway } from './gateway/follow.js'
import type { Warned } from './gateway/handlers/chrome.js'
import { writeActiveSessionFile } from './hermes/activeSessionFile.js'
import { PullRequests } from './github/store.js'
import { Media } from './media.js'
import type { NoticeEntry } from './model.js'
import { type Overlay, OverlayStack } from './overlay.js'
import { Completion } from './overlays/completion.js'
import { openHelp } from './overlays/help.js'
import { openUrl } from './overlays/pullRequests.js'
import { Cron } from './processes/cron.js'
import { Processes } from './processes/store.js'
import { hermesAuthor } from './processes/widgets/author.js'
import { chartMemory } from './processes/widgets/memory.js'
import { PromptSheets } from './prompts/sheets.js'
import { PrAside } from './prs/aside.js'
import { adoptSteps } from './session/adopt.js'
import { applyEffort } from './session/effort.js'
import { SessionLifecycle } from './session/lifecycle.js'
import { SessionState } from './session/state.js'
import { showThoughts } from './session/thoughts.js'
import { SessionTitle } from './session/title.js'
import type { SessionHost } from './sessionCommands.js'
import { fileSettings, type SettingsSource, type ThemeMode } from './settings.js'
import { Sidebar } from './sidebar.js'
import { onTernEvent } from './surface/actions.js'
import { INPUT_ID, SurfaceHost } from './surface/host.js'
import { runInput } from './surface/input.js'
import { Transcript } from './transcript.js'
import { Activity, type Busy } from './turn/activity.js'
import { IMAGE_ONLY_PROMPT, type Prompt } from './turn/prompt.js'
import { PromptQueue } from './turn/queue.js'
import { gateDrain, PromptRouter } from './turn/router.js'
import { randomTip, type WelcomeContext } from './view/welcome.js'

/** How long quitting waits for the sessions to detach. */
const QUIT_DETACH_MS = 1500

/** Runs the Tern frontend until the user quits; resolves the exit code. */
export class App implements ChatPorts {
  /** The open session's ids, info, usage and busy-input mode; every write renders. */
  readonly #state = new SessionState(() => this.changed())
  readonly transcript = new Transcript()
  /** Images tool calls showed, a URL's bytes fetched once and sent as a blob. */
  readonly media = new Media({ blob: (bytes, mime) => this.#act.blob(bytes, mime) })
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
  readonly #hud = new Hud({ changed: () => this.changed(), open: pill => this.#act.openPill(pill) })
  /** The conversation's PRs; links are stored under the stored session id the tools see. */
  readonly prs: PullRequests = new PullRequests({ changed: () => this.changed(), cwd: () => this.info?.cwd || null, sid: () => durable(this.#state.ref) })
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
  /** The open overlays; a modal one takes the keys from the completion list. */
  readonly #stack = new OverlayStack({
    changed: () => this.changed(),
    closed: overlay => this.#sheets.closed(overlay),
    opened: overlay => {
      if (overlay.modal) {
        // The sheet owns the keys now: a list or reply for the composer would only land under it.
        this.#completion.dismiss()
      }
    }
  })
  readonly overlays: Overlay[] = this.#stack.items
  /** The session as the ports read it: its ids and `info`, live. */
  readonly session: SessionView = this.#state
  /** The working line's busy state and the compaction phase: their one owner. */
  readonly #activity = new Activity()
  readonly #renders = new RenderScheduler(() => this.#frame())
  /** Timers with no field of their own (a compaction's summary read, the quit's detach wait). */
  readonly #timers = new Disposables()
  /** The last lone Esc and the first Ctrl+C of a quit, for the double presses. */
  readonly #presses: Presses = { esc: 0, exit: 0 }
  #done = Promise.withResolvers<number>()
  /** The prompt sheets the gateway's questions opened, and their approval-queue ids. */
  readonly #sheets: PromptSheets = new PromptSheets(this)
  /** The connect cards, kept current from the plugin's files. */
  readonly #connect: ConnectWatcher = new ConnectWatcher({ changed: () => this.changed(), openUrl, tell: text => this.#act.submit(text, false), transcript: this.transcript })
  /** The gateway connection: down until the next gateway.ready, and its redial line. */
  readonly #reconnect = new Reconnect(this)
  /** The backend warnings shown already (stray output, the last status warning), so each stays one line. */
  readonly #warned: Warned = { protocol: false, status: undefined }
  /** The gateway's keyed notices (credits, a slow start); the newest rides the status strip. */
  readonly #notices = new NoticeStrip(this)
  readonly #tern: Session
  readonly #gw: GatewayClient
  readonly #launch: LaunchEnv
  /** The draft's images, those still uploading, and the launcher's startup image. */
  readonly #attachments: Attachments
  /** The prompts waiting behind the turn: held here, and the shared gateway's queue for this session. */
  readonly #queue: PromptQueue
  /** Where each prompt goes: sent, the busy path, behind the turn, or held. */
  readonly #router: PromptRouter
  /** Which session the pane shows and how it switches: views, held requests, the adopt steps. */
  readonly #life: SessionLifecycle
  /** Whose colors the surface wears, and the gateway's skin. */
  readonly #theme: Theme
  readonly #completion: Completion
  readonly #welcome: WelcomeContext
  /** Background processes get live charts (settings.json `jobCharts`). */
  readonly #jobCharts: boolean
  /** What the user starts and the stores call back into, bound once. */
  readonly #act: AppActions
  #surface!: SurfaceHost
  /** What each frame draws from (app/frame.ts); set once run() opened the surface. */
  #view: FrameCx | undefined

  /** `launch` and `settings` are what entry.ts read once at startup; unset, each reads its default. */
  constructor(tern: Session, gw: GatewayClient, version: string, { launch = readLaunchEnv(), settings = fileSettings() }: { launch?: LaunchEnv; settings?: SettingsSource } = {}) {
    this.#tern = tern
    this.#gw = gw
    this.#launch = launch
    this.#attachments = new Attachments(
      {
        attachToHead: image => this.#queue.attachToHead(image),
        blob: (bytes, mime) => this.#act.blob(bytes, mime),
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
      canDrain: () => gateDrain(this.#act.gates()),
      changed: () => this.changed(),
      expanded: (sid, prompt) => this.#router.expanded(sid, prompt),
      gw,
      restore: prompt => this.#act.restore(prompt),
      send: prompt => this.#router.send(prompt, { queued: true }),
      ticket: () => this.#state.ticket(),
      transcript: this.transcript
    })
    this.#router = new PromptRouter({
      activity: this.#activity,
      changed: () => this.changed(),
      gates: () => this.#act.gates(),
      gw,
      queue: this.#queue,
      restore: prompt => this.#act.restore(prompt),
      ticket: () => this.#state.ticket(),
      transcript: this.transcript
    })
    this.#life = new SessionLifecycle(
      {
        attachStartup: sid => this.#act.attachStartupImage(sid),
        awaitingStartup: () => this.#attachments.awaitingStartup,
        busy: () => Boolean(this.busy),
        changed: () => this.changed(),
        cols: () => tern.caps.cols,
        drain: () => this.#queue.drain(),
        gw,
        launch,
        rename: (sid, title) => this.#title.rename(sid, title),
        request: req => this.#act.onRequest(req),
        sheets: this.#sheets,
        state: this.#state,
        transcript: this.transcript
      },
      adoptSteps({
        ...this.#stores(),
        forgetStatusNote: () => {
          this.#warned.status = undefined
        },
        imageLanded: call => this.#act.imageLanded(call),
        markViewer,
        readBusyMode: () => void this.#act.readBusyMode(),
        reportCwd: () => this.#act.reportCwd(),
        showThoughts: sid => showThoughts({ gw, notice: (text, tone) => this.notice(text, tone), settings }, sid),
        writeActiveSession: writeActiveSessionFile
      })
    )
    const saved = settings.load()
    this.#theme = new Theme({ palette: palette => this.#surface.palette(palette), settings }, saved.theme ?? 'tern')
    this.#jobCharts = saved.jobCharts !== false
    this.#completion = new Completion(this, gw, () => this.sid)
    this.#welcome = { tip: randomTip(launch.pythonSrcRoot), version: version && version !== 'unknown' ? `v${version}` : '' }
    this.#act = new AppActions({
      ...this.#stores(),
      attachments: this.#attachments,
      chat: this,
      completion: this.#completion,
      gw,
      launch,
      life: this.#life,
      router: this.#router,
      surface: () => this.#surface,
      tern
    })
  }

  /** The stores most contexts share: those the fields made, and the queue. */
  #stores() {
    return {
      activity: this.#activity,
      agents: this.agents,
      automation: this.automation,
      changed: () => this.changed(),
      composer: this.composer,
      connect: this.#connect,
      hud: this.#hud,
      media: this.media,
      notices: this.#notices,
      overlays: this.overlays,
      prAside: this.prAside,
      presses: this.#presses,
      processes: this.processes,
      prs: this.prs,
      queue: this.#queue,
      reconnect: this.#reconnect,
      session: this.#state,
      sheets: this.#sheets,
      sidebar: this.sidebar,
      state: this.#state,
      timers: this.#timers,
      title: this.#title,
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

  /** Whose colors the surface wears (`/theme`). */
  get theme(): ThemeMode {
    return this.#theme.mode
  }

  async run(): Promise<number> {
    this.#surface = new SurfaceHost(this.#tern, 'hermes')
    this.#view = {
      ...this.#stores(),
      actions: this.#act.dock,
      aside: () => this.#tern.caps.features.includes('aside'),
      attachments: this.#attachments,
      completion: this.#completion,
      copies: this.#act,
      surface: this.#surface,
      welcome: this.#welcome
    }
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

    followGateway(this.#gw, {
      ...this.#stores(),
      drain: () => this.#queue.drain(),
      eventLog: this.#launch.eventLog,
      gw: this.#gw,
      life: this.#life,
      reportCwd: () => this.#act.reportCwd(),
      request: req => this.#act.onRequest(req),
      setCompacting: on => this.#act.setCompacting(on),
      showImage: call => this.#act.showImage(call),
      sid: () => this.sid,
      summarize: delay => this.#act.summarize(delay),
      theme: this.#theme,
      warned: this.#warned
    })
    this.processes.poke()
    this.#frame()
    this.#surface.focus(INPUT_ID)
    // Keys and Tern events until the pane closes, each followed by a render; then the app quits.
    void runInput(this.#tern, {
      after: () => this.changed(),
      onError: error => this.transcript.notice(`Input failed: ${errorText(error)}`, 'error'),
      onEvent: event => onTernEvent(event, this.#act.events),
      onKey: key => onKey(key, this.#act.keys, this.overlays.at(-1))
    }).then(() => this.quit())

    const code = await this.#done.promise
    // Bounded, as Ink's deferExitForClose: a dead socket must not hold the terminal.
    await Promise.race([this.#life.leaveAll('tui_shutdown'), new Promise(resolve => this.#timers.timeout(() => resolve(undefined), QUIT_DETACH_MS))])
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
    this.#act.dispose()
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

  /** One frame of the whole view, once run() opened the surface. */
  #frame() {
    if (this.#view) {
      drawFrame(this.#view)
    }
  }

  open(overlay: Overlay) {
    this.#stack.open(overlay)
  }

  close(overlay: Overlay) {
    this.#stack.close(overlay)
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
    this.notice(`Unexpected error: ${errorText(reason)}`, 'error')
  }

  attachClipboardImage(quiet: boolean): Promise<void> {
    return this.#attachments.fromClipboard(quiet)
  }

  /** `/image <path>`: attaches that image file (resolved against the session's folder) to the next prompt. */
  attachImagePath(raw: string): Promise<void> {
    return this.#attachments.fromPath(raw)
  }

  toggleSidebar() {
    this.#act.toggleSidebar()
  }

  reveal(id: string) {
    this.#surface.reveal(id, 'start')
  }

  scroll(id: string, to: ScrollTo) {
    this.#surface.scroll(id, to)
  }

  openPrAside(key: PrKey | undefined) {
    this.#act.openPrAside(key)
  }

  /** A subagent ended: the PRs it linked are filed under this conversation (pull_requests.py). */
  agentEnded() {
    this.prs.relink()
  }

  openAgent(id: string): Promise<void> {
    return this.#act.openAgent(id)
  }

  openHelp(): Promise<void> {
    return openHelp(this)
  }

  quit(code = 0) {
    markViewer(null, durable(this.#state.ref))
    this.#done.resolve(code)
  }

  control(): SessionHost {
    return sessionHost(this.#act.host)
  }

  newSession(title?: string): Promise<void> {
    return this.#life.newSession(title)
  }

  resume(id: StoredSessionId): Promise<void> {
    return this.#life.resume(id)
  }

  /** Acts on a command's dispatch envelope from outside a typed command (a goal or loop sheet's button). */
  runDispatch(raw: unknown, title: string): Promise<void> {
    return dispatched(raw, this.#act.slash, { arg: '', title })
  }

  setTheme(mode: ThemeMode) {
    this.#theme.set(mode)
    this.changed()
  }

  setEffort(value: string, scope: 'global' | 'session'): Promise<void> {
    return applyEffort(this, value, scope)
  }
}
