// The app: one inline Tern surface (role `omp.session`, so Tern's chat styles
// apply) over one tui_gateway session. Gateway events fold into the
// transcript, keys go to the top overlay or the composer, and every change
// schedules one frame of the whole view (app/frame.ts); the SDK diffs it into
// frame ops. App is the composition root: it makes the stores (app/stores.ts)
// and the actions over them (app/actions.ts), lends them as ChatPorts, and
// runs the pane until it quits.

import type { ScrollTo, Session } from '@stencil-hq/tern'
import type { GatewayClient } from '@tui/gatewayClient.js'

import logo from '../../assets/logo.png'
import type { Agents } from '../agents/store.js'
import type { Automation } from '../automation.js'
import { type LaunchEnv, readLaunchEnv } from '../config/env.js'
import { sessionHost } from '../commands/host.js'
import { dispatched } from '../commands/slash.js'
import type { Composer } from '../composer.js'
import { markViewer } from '../connections.js'
import { errorText } from '../core/errors.js'
import { durable, entryId, type PrKey, type StoredSessionId } from '../core/ids.js'
import { RenderScheduler } from '../core/scheduler.js'
import { onKey } from '../draft/keys.js'
import { followGateway } from '../gateway/follow.js'
import type { PullRequests } from '../github/store.js'
import type { Media } from '../media.js'
import type { NoticeEntry } from '../model.js'
import type { Overlay } from '../overlay.js'
import { openHelp } from '../overlays/help.js'
import type { Cron } from '../processes/cron.js'
import type { Processes } from '../processes/store.js'
import type { PrAside } from '../prs/aside.js'
import { applyEffort } from '../session/effort.js'
import type { SessionState } from '../session/state.js'
import type { SessionTitle } from '../session/title.js'
import type { SessionHost } from '../sessionCommands.js'
import { fileSettings, type SettingsSource, type ThemeMode } from '../settings.js'
import type { Sidebar } from '../sidebar.js'
import { onTernEvent } from '../surface/actions.js'
import { INPUT_ID, SurfaceHost } from '../surface/host.js'
import { runInput } from '../surface/input.js'
import type { Transcript } from '../transcript.js'
import type { Activity, Busy } from '../turn/activity.js'
import { IMAGE_ONLY_PROMPT } from '../turn/prompt.js'
import type { PromptQueue } from '../turn/queue.js'
import { noticeSink, onCardFault } from '../view/tools/faults.js'

import { AppActions } from './actions.js'
import { drawFrame, type FrameCx } from './frame.js'
import type { ChatPorts } from './ports.js'
import { type ChatStores, chatStores, disposeStores } from './stores.js'

/** How long quitting waits for the sessions to detach. */
const QUIT_DETACH_MS = 1500

/** Runs the Tern frontend until the user quits; resolves the exit code. */
export class App implements ChatPorts {
  // The stores the ports lend, and the tests read (app/stores.ts says what each one holds).
  readonly session: SessionState
  readonly transcript: Transcript
  readonly activity: Activity
  readonly media: Media
  readonly agents: Agents
  readonly processes: Processes
  readonly cron: Cron
  readonly sidebar: Sidebar
  readonly automation: Automation
  readonly title: SessionTitle
  readonly prs: PullRequests
  readonly prAside: PrAside
  readonly composer: Composer
  readonly overlays: Overlay[]
  readonly queue: PromptQueue
  /** Every store, the ones above among them. */
  readonly #s: ChatStores
  readonly #renders = new RenderScheduler(() => this.#frame())
  #done = Promise.withResolvers<number>()
  readonly #tern: Session
  readonly #gw: GatewayClient
  readonly #launch: LaunchEnv
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
    const s = chatStores(this, { act: () => this.#act, gw, launch, settings, surface: () => this.#surface, tern, version })
    this.#s = s
    this.session = s.session
    this.transcript = s.transcript
    this.activity = s.activity
    this.media = s.media
    this.agents = s.agents
    this.processes = s.processes
    this.cron = s.cron
    this.sidebar = s.sidebar
    this.automation = s.automation
    this.title = s.title
    this.prs = s.prs
    this.prAside = s.prAside
    this.composer = s.composer
    this.overlays = s.overlays
    this.queue = s.queue
    this.#act = new AppActions({ ...s, chat: this, gw, launch, surface: () => this.#surface, tern })
  }

  /** The running turn (or a send's `{!cmd}`s), null when idle. */
  get busy(): Busy | null {
    return this.activity.busy
  }

  /** The gateway, for overlays that issue their own RPCs. */
  get gw(): GatewayClient {
    return this.#gw
  }

  /** Whose colors the surface wears (`/theme`). */
  get theme(): ThemeMode {
    return this.#s.theme.mode
  }

  async run(): Promise<number> {
    const s = this.#s
    this.#surface = new SurfaceHost(this.#tern, 'hermes')
    this.#view = {
      ...s,
      actions: this.#act.dock,
      aside: () => this.#tern.caps.features.includes('aside'),
      copies: this.#act,
      surface: this.#surface
    }
    s.theme.apply()
    // A card that throws draws as the generic one, and the pane says so once per tool name.
    onCardFault(noticeSink(text => this.notice(text, 'warning')))

    if (this.#tern.caps.features.includes('blobs')) {
      s.welcome.logo = this.#tern.blob(logo, 'image/png')
    }

    this.transcript.push({ id: entryId('welcome'), kind: 'welcome' })

    // `hermes -q …`: the launcher's query is the first prompt, sent literally once the first session is adopted.
    const query = this.#launch.query

    if (query || s.attachments.awaitingStartup) {
      this.queue.hold({ images: [], kind: 'app', text: query || IMAGE_ONLY_PROMPT })
    }

    followGateway(this.#gw, {
      ...s,
      drain: () => this.queue.drain(),
      eventLog: this.#launch.eventLog,
      gw: this.#gw,
      reportCwd: () => this.#act.reportCwd(),
      request: req => this.#act.onRequest(req),
      setCompacting: on => this.#act.setCompacting(on),
      showImage: call => this.#act.showImage(call),
      sid: () => this.session.ref.live,
      summarize: delay => this.#act.summarize(delay)
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
    await Promise.race([s.life.leaveAll('tui_shutdown'), new Promise(resolve => s.timers.timeout(() => resolve(undefined), QUIT_DETACH_MS))])
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
    disposeStores(this.#s)
  }

  /** One frame of the whole view, once run() opened the surface. */
  #frame() {
    if (this.#view) {
      drawFrame(this.#view)
    }
  }

  open(overlay: Overlay) {
    this.#s.stack.open(overlay)
  }

  close(overlay: Overlay) {
    this.#s.stack.close(overlay)
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
    return this.#s.attachments.fromClipboard(quiet)
  }

  /** `/image <path>`: attaches that image file (resolved against the session's folder) to the next prompt. */
  attachImagePath(raw: string): Promise<void> {
    return this.#s.attachments.fromPath(raw)
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
    markViewer(null, durable(this.session.ref))
    this.#done.resolve(code)
  }

  control(): SessionHost {
    return sessionHost(this.#act.host)
  }

  newSession(title?: string): Promise<void> {
    return this.#s.life.newSession(title)
  }

  resume(id: StoredSessionId): Promise<void> {
    return this.#s.life.resume(id)
  }

  /** Acts on a command's dispatch envelope from outside a typed command (a goal or loop sheet's button). */
  runDispatch(raw: unknown, title: string): Promise<void> {
    return dispatched(raw, this.#act.slash, { arg: '', title })
  }

  setTheme(mode: ThemeMode) {
    this.#s.theme.set(mode)
    this.changed()
  }

  setEffort(value: string, scope: 'global' | 'session'): Promise<void> {
    return applyEffort(this, value, scope)
  }
}
