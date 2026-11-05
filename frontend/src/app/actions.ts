// What the user starts, and what the stores call back into, bound once over the app's stores:
// the dock's buttons (DockActions), a draft's way to the router (a command, a `!cmd` or a prompt),
// the interrupt, the pills' sheets, the Copy buttons, the sidebar and the PR aside; and the
// contexts the key rules, the Tern actions and the commands reach. App makes one AppActions in
// its constructor; nothing here is made again per frame.

import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import type { Key, Session } from '@stencil-hq/tern'
import type { GatewayClient } from '@tui/gatewayClient.js'

import { Artifacts } from '../artifacts.js'
import type { BtwThreads } from '../btw.js'
import type { Hud, SheetPill } from '../chrome/hud.js'
import type { Sidebar } from '../chrome/sidebar.js'
import { copyToClipboard } from '../clipboard.js'
import type { SessionHostCx } from '../commands/host.js'
import { CommandCatalog } from '../commands/resolve.js'
import { runSlash, type SlashCx } from '../commands/slash.js'
import type { LaunchEnv } from '../config/env.js'
import type { ConnectWatcher } from '../connections/watcher.js'
import type { Disposables } from '../core/disposables.js'
import { Flash } from '../core/flash.js'
import type { PrKey } from '../core/ids.js'
import type { Attachments } from '../draft/attachments.js'
import type { Composer } from '../draft/composer.js'
import type { KeyCx, Presses } from '../draft/keys.js'
import { forkSession } from '../fork-session.js'
import { shellError, shellExec, shellLines } from '../hermes/shell.js'
import type { Media } from '../media.js'
import type { ToolCall } from '../model.js'
import { openAgents } from '../overlays/agents.js'
import { openAutomation } from '../overlays/automation.js'
import { openBackground } from '../overlays/background.js'
import { openBrowserBlocks } from '../overlays/browser.js'
import type { Completion } from '../overlays/completion.js'
import { openContext } from '../overlays/context.js'
import { openEffortPicker } from '../overlays/effort.js'
import { openModelPicker } from '../overlays/models.js'
import { openPlanReview } from '../overlays/plan.js'
import { openPrMenu, openUrl } from '../overlays/pullRequests.js'
import type { PromptSheets } from '../prompts/sheets.js'
import type { PrAside } from '../prs/aside.js'
import { cycleEffort, DEFAULT_EFFORT } from '../session/effort.js'
import { BindingPreferences } from '../shortcuts/binding-preferences.js'
import { cycleModel } from '../shortcuts/model-cycle.js'
import type { SessionLifecycle } from '../session/lifecycle.js'
import type { SessionState } from '../session/state.js'
import type { ActionCx } from '../surface/actions.js'
import { INPUT_ID, type SurfaceHost } from '../surface/host.js'
import { reportCwd } from '../surface/osc.js'
import type { Transcript } from '../transcript/store.js'
import type { TodoHud } from '../todo-hud.js'
import type { Activity } from '../turn/activity.js'
import { BusyDraft, busyIntent } from '../turn/busyInput.js'
import type { Prompt } from '../turn/prompt.js'
import type { PromptQueue } from '../turn/queue.js'
import type { GateState, PromptRouter } from '../turn/router.js'
import type { BusyMode } from '../turn/serverQueue.js'
import type { DockActions } from '../view/dock.js'
import { isModal } from '../view/dockModel.js'
import type { LiveVoice } from '../voice/live.js'

import { openAppPalette } from './palette.js'
import { copyComposer, attachNativeImage } from './native-artifacts.js'
import { shouldSteer } from './busy-intent.js'
import {
  attachStartupImage as attachActionStartupImage,
  gates as actionGates,
  interrupt as interruptAction,
  onRequest as onActionRequest,
  readBusyMode as readActionBusyMode,
  restore as restoreAction,
  setCompacting as setActionCompacting,
  summarize as summarizeAction
} from './actions-session.js'
import {
  blob as actionBlob,
  hudKey as actionHudKey,
  imageLanded as actionImageLanded,
  openAgent as openActionAgent,
  openPill as openActionPill,
  openPrAside as openActionPrAside,
  showArtifacts as showActionArtifacts,
  showImage as showActionImage,
  toggleSidebar as toggleActionSidebar
} from './actions-ui.js'
import type { ChatPorts } from './ports.js'

/** The stores the actions act on, and the app's ports for the sheets they open. */
export interface ActionsCx {
  readonly chat: ChatPorts
  readonly tern: Pick<Session, 'blob' | 'caps'>
  readonly gw: GatewayClient
  readonly launch: Pick<LaunchEnv, 'home'>
  readonly state: SessionState
  readonly btw: Pick<BtwThreads, 'viewNotice' | 'dismissNotice'>
  readonly activity: Activity
  readonly attachments: Attachments
  readonly queue: PromptQueue
  readonly router: PromptRouter
  readonly life: SessionLifecycle
  readonly sheets: PromptSheets
  readonly completion: Completion
  readonly hud: Hud
  readonly composer: Composer
  readonly liveVoice: LiveVoice
  readonly transcript: Transcript
  readonly todoHud: TodoHud
  readonly media: Media
  readonly connect: ConnectWatcher
  readonly sidebar: Sidebar
  readonly prAside: PrAside
  /** Timers with no field of their own (a compaction's summary read). */
  readonly timers: Disposables
  /** The last lone Esc and the first Ctrl+C of a quit, for the double presses. */
  readonly presses: Presses
  /** The surface run() opened. */
  surface(): SurfaceHost
  changed(): void
}

/** The app's actions and the contexts its entry points reach, made once. */
export class AppActions {
  readonly #cx: ActionsCx
  readonly #busyDraft: BusyDraft
  /** The entry whose Copy button reads Copied, until its time is up. */
  readonly #copied = new Flash<string>(() => this.#cx.changed())
  /** The folder last reported to Tern by OSC 7. */
  #reportedCwd: string | undefined
  readonly #artifacts = new Artifacts()
  /** What the dock's buttons and fields do. */
  readonly dock: DockActions
  /** What the key rules (draft/keys.ts) reach. */
  readonly keys: KeyCx
  readonly bindings: BindingPreferences
  /** Tern actions. */
  readonly events: ActionCx
  /** What a slash command reaches (commands/slash.ts). */
  readonly slash: SlashCx
  /** What the control and session commands' host is made from (commands/host.ts). */
  readonly host: SessionHostCx
  constructor(cx: ActionsCx) {
    this.#cx = cx
    const { attachments, chat, composer, gw, life, queue, transcript } = cx
    const changed = () => cx.changed()
    const admit = () => !isModal(chat.overlays) && !life.switching && !attachments.any && !attachments.uploading
    this.#busyDraft = new BusyDraft({ activity: cx.activity, admit, composer, gw, router: cx.router, session: cx.state, transcript, changed })

    this.bindings = new BindingPreferences({ gw, session: cx.state, changed, notice: text => chat.notice(text, 'warning') })
    this.dock = {
      onBtwView: notice => cx.btw.viewNotice(notice),
      onBtwDismiss: notice => cx.btw.dismissNotice(notice),
      onAgents: () => openAgents(chat),
      onNotices: () => chat.openNotices(),
      onContext: () => openContext({ changed, close: o => chat.close(o), gw, open: o => chat.open(o), session: cx.state }),
      onEdit: ev => {
        if (composer.vim.enabled) return
        composer.edit(ev)
        changed()
      },
      onEffort: () => cycleEffort(chat),
      onEffortMenu: {
        'choose-effort': () => openEffortPicker(chat),
        'save-effort-as-default': () => void chat.setEffort(cx.state.info?.reasoning_effort || DEFAULT_EFFORT, 'global')
      },
      onGoal: () => openAutomation(chat, 'goal'),
      onInterrupt: () => this.interrupt(),
      onLoop: () => openAutomation(chat, 'loop'),
      onModel: () => openModelPicker(chat),
      onPrs: () => openPrMenu(chat),
      onQueueEdit: i => queue.dequeue(i),
      onQueueSteer: i => queue.steer(i),
      onRemoveAttachment: i => attachments.remove(i),
      onSend: ev => {
        if (composer.vim.enabled) return
        this.submitNative(ev.text)
        changed()
      },
      onShells: () => openBackground(chat),
      onSubmit: () => {
        this.submitDraft()
        changed()
      },
      onTodos: () => cx.hud.toggleTodos(),
      onUndo: () => {
        if (composer.vim.enabled) return
        composer.undo()
        changed()
      }
    }
    this.keys = {
      attachClipboardImage: () => void attachments.fromClipboard(false),
      attachments,
      copyDraft: currentLine => copyComposer(cx, currentLine),
      busy: () => cx.activity.busy !== null,
      close: overlay => chat.close(overlay),
      completion: cx.completion,
      composer,
      liveVoice: cx.liveVoice,
      vim: composer.vim,
      cycleEffort: () => cycleEffort(chat),
      fork: () => void forkSession(chat),
      hud: key => this.hudKey(key),
      interrupt: () => this.interrupt(),
      now: Date.now,
      openAgents: () => openAgents(chat),
      openBackground: () => openBackground(chat),
      openBrowserBlocks: () => openBrowserBlocks(chat),
      openExternalEditor: () => void chat.editExternal(),
      openPrs: () => openPrMenu(chat),
      openModel: () => openModelPicker(chat),
      openPalette: () => this.openPalette(),
      openHelp: () => void chat.openHelp(),
      cycleModel: direction => void cycleModel(chat, direction),
      shortcut: (id, key) => this.bindings.matches(id, key),
      openPlan: () => openPlanReview(chat),
      presses: cx.presses,
      queue,
      quit: () => chat.quit(),
      submitDraft: () => this.submitDraft(),
      steerDraft: () => this.submitDraft(true),
      toggleSidebar: () => this.toggleSidebar(),
      transcript
    }
    this.events = {
      attachNativeImage: image => attachNativeImage(cx, image),
      connect: cx.connect,
      focusComposer: () => {
        cx.hud.release()
        cx.surface().focus(INPUT_ID)
      },
      modal: () => isModal(chat.overlays),
      openAgent: id => void this.openAgent(id),
      openAgents: () => openAgents(chat),
      openProcess: id => openBackground(chat, id),
      openUrl
    }
    this.slash = {
      attachments,
      catalog: new CommandCatalog(gw),
      changed,
      composer,
      gw,
      host: chat,
      life,
      prompt: item => cx.router.route(item, 'queue'),
      transcript
    }
    this.host = {
      activity: cx.activity,
      changed,
      draft: text => composer.set(composer.text ? `${text}\n${composer.text}` : text, { pasted: composer.pasted }),
      gw,
      life,
      queue,
      router: cx.router,
      setCompacting: (on, opts) => this.setCompacting(on, opts),
      state: cx.state,
      submit: (text, literal) => this.submit(text, true, 'queue', literal ? [text] : []),
      transcript
    }
  }

  /** The native command palette dispatches through the existing command route. */
  openPalette() {
    openAppPalette(this.#cx, command => this.submit(command, false))
  }

  /** The entry whose Copy button reads Copied. */
  get copied(): string | undefined {
    return this.#copied.value
  }

  /** A Copy button: `text` to the clipboard, and its button reads Copied for a moment. */
  readonly copy = (text: string, id: string) => {
    copyToClipboard(text)
    // It asks for a render: node handlers consume their event, so the input loop's re-render never sees this one.
    this.#copied.set(id)
  }

  /** Clears the Copied timer. */
  dispose() {
    this.#copied.dispose()
  }

  // ── Prompts and commands ───────────────────────────────────────────

  /** Sends the composer's draft, with the pastes it holds. */
  submitDraft(alternate = false) {
    if (this.#cx.liveVoice.blocked || isModal(this.#cx.chat.overlays)) return
    const raw = this.#cx.composer.text

    if (shouldSteer(this.#cx, raw, alternate)) {
      void this.#busyDraft.steer(raw)
      return
    }

    const pasted = [...this.#cx.composer.shellPasted]
    this.submit(this.#cx.composer.take(), true, 'queue', pasted)
  }

  /** Tern native Send obeys the same busy intent as keyboard Enter. */
  submitNative(raw: string) {
    if (isModal(this.#cx.chat.overlays)) return
    if (shouldSteer(this.#cx, raw, false)) {
      void this.#busyDraft.steer(raw)
      return
    }

    const unknown = raw !== this.#cx.composer.text
    this.submit(raw, true, 'queue', unknown || this.#cx.composer.literal ? [raw] : this.#cx.composer.pasted.filter(p => raw.includes(p)))
  }

  /** Sends or queues a prompt, or runs a command. A draft takes its images; `busy` controls
   * routing during a turn. Shell syntax covered by `pasted` markers stays literal. */
  submit(raw: string, draft = true, busy: BusyMode = draft ? busyIntent(this.#cx.state.busyMode) : 'queue', pasted: readonly string[] = []) {
    const { attachments, composer, transcript } = this.#cx
    // Tern native Send and keyboard Enter never take the draft while voice owns input.
    if (draft && this.#cx.liveVoice.blocked) return
    const text = raw.trim()

    // An image still uploading would miss the prompt: the words wait in the composer for it.
    if (draft && attachments.uploading && !text.startsWith('/')) {
      composer.set(raw, { pasted })
      transcript.notice('An image is still attaching. Send again in a moment.', 'warning')

      return
    }

    // Images alone are a prompt: the bubble shows just them (the gateway gets Ink's stand-in words).
    if (!text && !(draft && attachments.items.length)) {
      return
    }

    if (!text.startsWith('/') && pasted.length && (text.startsWith('!') || text.includes('{!'))) {
      transcript.notice('Shell syntax is sent as text because its origin is unverified.', 'warning')
    }

    if (text.startsWith('/')) {
      void runSlash(text, this.slash, true, pasted.length > 0)

      return
    }

    // `!cmd` runs a shell command now, beside any turn (Ink's shellExec); a pasted one is a prompt.
    if (text.startsWith('!') && text.slice(1).trim() && !pasted.some(p => text.startsWith(p.trim().split('\n')[0] ?? ''))) {
      void this.#shell(text.slice(1).trim())

      return
    }

    // The draft's images go with this prompt, whenever it is sent; a message the app writes leaves them.
    this.#cx.router.route({ images: draft ? attachments.take() : [], kind: 'typed', pasted, text }, busy)
  }

  /** What the router's gates read: the session, the switch in flight, the turn, the compaction and the startup image. */
  gates(): GateState {
    return actionGates(this.#cx)
  }

  /** Puts a prompt that did not go back into the composer, before any text there, with its images. */
  restore(prompt: Prompt) {
    restoreAction(this.#cx, prompt)
  }

  /** `!cmd`: runs `command` in the session's folder and shows its output; nothing reaches the model. */
  async #shell(command: string) {
    const { transcript } = this.#cx
    const sid = this.#cx.state.ref.live

    if (!sid) {
      transcript.notice('Wait for the session to start before running a shell command.', 'warning')

      return this.#cx.changed()
    }

    transcript.user({ text: `!${command}` })
    this.#cx.changed()

    try {
      for (const line of shellLines(await shellExec(this.#cx.gw, sid, command))) {
        transcript.notice(line.text, line.failed ? 'warning' : 'info')
      }
    } catch (error) {
      transcript.notice(`!${command} did not run: ${shellError(error)}.`, 'error')
    }

    this.#cx.changed()
  }

  /**
   * Stops the running turn: the working line says Stopping… until the stream's next label. A
   * failure speaks only for the turn it tried to stop: once that row is gone, it says nothing.
   */
  interrupt() {
    interruptAction(this.#cx)
  }

  /**
   * A compaction started (`manual`: /compress's) or ended. While one runs the working line says so
   * until its done edge, and with no turn running the dock shows it and prompts queue behind it;
   * those go once it ends.
   */
  setCompacting(on: boolean, options: { manual?: boolean } = {}) {
    setActionCompacting(this.#cx, on, options)
  }

  /** Gives the compactions seen here their summaries from the store, `delay` ms from now. */
  summarize(delay = 0) {
    summarizeAction(this.#cx, delay)
  }

  /** Reads the shown session's busy_input_mode; an older gateway without it leaves Enter queueing (the TUI default). */
  async readBusyMode() {
    return readActionBusyMode(this.#cx)
  }

  /** `hermes -q … --image …`: attaches the image to the first session, then lets the startup query go. */
  async attachStartupImage(sid: string) {
    return attachActionStartupImage(this.#cx, sid)
  }


  /** A server request: its prompt sheet, unless a switch holds it or it is another session's. */
  onRequest(req: ServerRequest) {
    onActionRequest(this.#cx, req)
  }

  /** `bytes` sent to Tern as a blob; undefined where it takes none, or for more than a blob holds. */
  blob(bytes: Uint8Array, mime: string): string | undefined {
    return actionBlob(this.#cx, bytes, mime)
  }

  /** Has `call`'s image (a URL's) fetched; its card shows it once it lands. */
  showImage(call: ToolCall | undefined) {
    showActionImage(this.#cx, call, landed => this.imageLanded(landed))
  }

  /** Opens model outputs beside the live chat. */
  showArtifacts(call: ToolCall | undefined) {
    showActionArtifacts(this.#cx, this.#artifacts, call)
  }

  /** A tool call's image landed: its card draws again. */
  imageLanded(call: ToolCall) {
    actionImageLanded(this.#cx, call)
  }

  /** Tells Tern the session's folder when it moved (`hermes -w tern`, a moved workspace): OSC 7. */
  reportCwd() {
    const cwd = this.#cx.state.info?.cwd

    if (cwd && cwd !== this.#reportedCwd) {
      this.#reportedCwd = cwd
      reportCwd(cwd)
    }
  }

  // ── Pills, the sidebar and the PR aside ────────────────────────────

  /** Down from an empty prompt focuses the pills; ←/→, Enter and Esc/↑ while one holds the keys. */
  hudKey(key: Key): boolean {
    return actionHudKey(this.#cx, key)
  }

  /** Opens the sheet behind a pill. */
  openPill(pill: SheetPill) {
    openActionPill(this.#cx, pill)
  }

  /** Opens or closes the session sidebar (Tern's aside); says why where Tern has none. */
  toggleSidebar() {
    toggleActionSidebar(this.#cx)
  }

  /** Docks PR `key` at the pane's right edge, in place of the session sidebar. */
  openPrAside(key: PrKey | undefined) {
    openActionPrAside(this.#cx, key)
  }

  /** Shows subagent `id` beside the chat in a Tern split; its timeline sheet where no split can open. */
  async openAgent(id: string) {
    return openActionAgent(this.#cx, id)
  }
}
