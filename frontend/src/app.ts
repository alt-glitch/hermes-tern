// The app: one inline Tern surface (role `omp.session`, so Tern's chat styles
// apply) over one tui_gateway session. Gateway events fold into the
// transcript, keys go to the top overlay or the composer, and every change
// schedules one render of the whole view; the SDK diffs it into frame ops.

import { randomUUID } from 'node:crypto'

import type {
  SessionLiveInfo,
  SessionResumeResult,
  SkinPayload,
  TranscriptMessage,
  Usage
} from '@hermes/shared/gateway-events'
import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import { parseCommandDispatch } from '@hermes/shared/slash'
import type { Key, Session, Surface, TspEvent } from '@stencil-hq/tern'
import { describeSlashExecError, isUnsupportedCommand, shouldFallbackToDispatch } from '@tui/app/userMessages.js'
import { localCreationOptions } from '@tui/canonicalGateway.js'
import type { GatewayClient } from '@tui/gatewayClient.js'
import type { AnyGatewayEvent } from '@tui/gatewayTypes.js'

import logo from '../assets/logo.png'

import { copyToClipboard } from './clipboard.js'
import { localCommand } from './commands.js'
import { Composer } from './composer.js'
import { type ControlHost, interruptTurn } from './controlCommands.js'
import { type Busy, busyFrom, ownsEvent, Switches } from './flow.js'
import type { Overlay, OverlayHost } from './overlay.js'
import { writeActiveSessionFile } from './hermes/activeSessionFile.js'
import { type Attachment, uploadImage } from './hermes/images.js'
import { sharedPromptId, sharedPromptRequest } from './hermes/sharedPrompts.js'
import { Completion } from './overlays/completion.js'
import { openModelPicker } from './overlays/models.js'
import { promptOverlay } from './overlays/prompts.js'
import { paletteOf } from './palette.js'
import { Transcript } from './transcript.js'
import { dockNodes } from './view/dock.js'
import { entryNode } from './view/transcript.js'
import { randomTip, type WelcomeContext } from './view/welcome.js'

/** The composer's `editor` node id (dock → composer → line → input). */
export const INPUT_ID = 'dock.composer.line.input'

const EXIT_ARM_MS = 1500
/** How long a prompt's Copy button reads Copied. */
const COPIED_MS = 1500
/** What Shift+Tab / the effort chip cycle through (hermes's `none` turns reasoning off). */
const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh']

/** session.create's result, or session.resume's with the state of a turn it may be in. */
interface CreateResult extends Partial<
  Pick<SessionResumeResult, 'inflight' | 'running' | 'status' | 'turn_started_at'>
> {
  session_id: string
  /** This view's subscription on the shared gateway: what `session.detach` releases. */
  subscription_id?: string
  stored_session_id?: string | null
  info?: SessionLiveInfo
  messages?: TranscriptMessage[]
}

/** Runs the Tern frontend until the user quits; resolves the exit code. */
export class App implements OverlayHost {
  readonly transcript = new Transcript()
  readonly composer = new Composer()
  readonly overlays: Overlay[] = []
  sid: string | null = null
  /** The stored (database) id of the open session: what `session.list` rows are keyed by. */
  storedSid: string | null = null
  info: SessionLiveInfo | null = null
  usage: Usage | null = null
  busy: Busy | null = null
  queue: string[] = []
  readonly #tern: Session
  readonly #gw: GatewayClient
  readonly #completion: Completion
  readonly #welcome: WelcomeContext
  #surface!: Surface
  #scheduled = false
  /** The field holding Tern's caret, as last sent. */
  #focus: string | null = INPUT_ID
  #exitArmed = 0
  #done = Promise.withResolvers<number>()
  readonly #switches = new Switches()
  /** Server requests for another session, kept while a switch is in flight. */
  #heldRequests: ServerRequest[] = []
  /** Shared-gateway subscriptions this view holds, by session id. */
  readonly #subscriptions = new Map<string, string>()
  /** Open approval prompts' overlay keys → their approval-queue `request_id` (what approval.cancelled names). */
  readonly #approvalIds = new Map<string, string>()
  /** The launcher's startup image until it is attached to the first session (the queue waits for it). */
  #startupImage = process.env.HERMES_TUI_IMAGE?.trim() ?? ''
  /** Uploaded images the next prompt carries (the shared gateway takes them on prompt.submit). */
  #attachments: Attachment[] = []
  /** The prompt whose Copy button reads Copied, until the timer clears it. */
  #copied: string | undefined
  #copiedTimer: NodeJS.Timeout | undefined

  constructor(tern: Session, gw: GatewayClient, version: string) {
    this.#tern = tern
    this.#gw = gw
    this.#completion = new Completion(this, gw, () => this.sid)
    this.#welcome = {
      tip: randomTip(process.env.HERMES_PYTHON_SRC_ROOT ?? ''),
      version: version && version !== 'unknown' ? `v${version}` : ''
    }
  }

  /** The gateway, for overlays that issue their own RPCs. */
  get gw(): GatewayClient {
    return this.#gw
  }

  async run(): Promise<number> {
    this.#surface = this.#tern.open({ id: 'hermes', mode: 'inline', role: 'omp.session', title: 'hermes' })

    if (this.#tern.caps.features.includes('blobs')) {
      this.#welcome.logo = this.#tern.blob(logo, 'image/png')
    }

    this.transcript.push({ id: 'welcome', kind: 'welcome' })

    // `hermes -q …`: the launcher's query is the first prompt, sent literally once the first session is adopted.
    const query = process.env.HERMES_TUI_QUERY?.trim()

    if (query || this.#startupImage) {
      this.queue.push(query || 'What do you see in this image?')
    }

    this.#gw.on('event', (ev: AnyGatewayEvent) => this.#onGatewayEvent(ev))
    this.#gw.on('request', (req: ServerRequest) => this.#onRequest(req))
    this.#gw.on('exit', (code: null | number) => {
      this.transcript.notice(`The agent backend exited${code === null ? '' : ` (${code})`}.`, 'error')
      // The runtime session died with the process: prompts queue until the next gateway.ready reattaches.
      this.sid = null
      this.busy = null
      this.transcript.interrupt()
      this.changed()
    })
    this.#gw.drain()
    this.#render()
    this.#surface.focus(INPUT_ID)
    void this.#readInput()

    const code = await this.#done.promise
    await Promise.all([...this.#subscriptions.keys()].map(sid => this.#leave(sid, 'tui_shutdown')))
    await this.#tern.close()
    this.#gw.kill('exit')

    return code
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
      this.changed()
    }
  }

  changed() {
    if (this.#scheduled) {
      return
    }

    this.#scheduled = true
    setImmediate(() => {
      this.#scheduled = false
      this.#render()
    })
  }

  // ── Input ──────────────────────────────────────────────────────────

  async #readInput() {
    try {
      for await (const input of this.#tern) {
        if (input.type === 'key') {
          this.#onKey(input.key)
        } else {
          this.#onTernEvent(input.event)
        }

        this.changed()
      }
    } catch (error) {
      this.transcript.notice(`Input failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }

    this.quit()
  }

  #onKey(key: Key) {
    const top = this.overlays.at(-1)

    if (key.ctrl && key.name === 'c') {
      return this.#ctrlC()
    }

    if (top?.onKey(key)) {
      return
    }

    if (top?.modal) {
      return
    }

    if (this.#completion.onKey(key)) {
      return
    }

    if (key.name === 'escape') {
      if (this.busy) {
        this.#interrupt()
      }

      return
    }

    if (key.shift && key.name === 'tab') {
      return this.#cycleEffort()
    }

    if (key.alt && key.name === 'up' && this.queue.length) {
      return this.#dequeue()
    }

    if (key.ctrl && key.name === 'd' && !this.composer.text) {
      return this.quit()
    }

    const action = this.composer.key(key)

    if (action === 'submit') {
      this.#submit(this.composer.take())
    }
  }

  #onTernEvent(ev: TspEvent) {
    if (ev.ev === 'focus' && ev.id === INPUT_ID && !this.overlays.at(-1)?.modal) {
      this.#focus = INPUT_ID
      this.#surface.focus(INPUT_ID)
    }
  }

  #ctrlC() {
    if (this.composer.text) {
      this.composer.set('')

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
    this.#done.resolve(code)
  }

  // ── Prompts and commands ───────────────────────────────────────────

  #submit(raw: string) {
    const text = raw.trim()

    if (!text) {
      return
    }

    if (text.startsWith('/')) {
      void this.#slash(text)

      return
    }

    if (this.busy || !this.sid || this.#switches.pending) {
      this.queue.push(text)

      return
    }

    this.#send(text)
  }

  /** Sends `text` now; `queued` marks a drained queue entry (the gateway must queue it, never steer with it). */
  #send(text: string, { display, queued = false }: { display?: string; queued?: boolean } = {}) {
    // A session switch in flight: the prompt belongs to the session it adopts.
    if (!this.sid || this.#switches.pending) {
      this.queue.unshift(text)

      return
    }

    const attachments = this.#attachments
    this.#attachments = []
    this.transcript.user(display?.trim() || text)
    this.#startBusy('Working…')
    this.#gw
      // The shared gateway admits a prompt by its submission id (a retry with the same id is one turn).
      .request('prompt.submit', {
        session_id: this.sid,
        submission_id: randomUUID(),
        text,
        ...(queued ? { queued } : {}),
        ...(attachments.length ? { attachments } : {})
      })
      .catch((error: Error) => {
        this.transcript.notice(error.message, 'error')
        this.busy = null
        this.changed()
      })
  }

  async #slash(text: string) {
    const [name = '', ...rest] = text.slice(1).split(/\s+/)
    const arg = rest.join(' ')
    const local = localCommand(name)

    if (local) {
      try {
        const handled = await local.run(this, arg)

        if (handled !== false) {
          return this.changed()
        }
      } catch (error) {
        this.transcript.notice(error instanceof Error ? error.message : String(error), 'error')

        return this.changed()
      }
    }

    if (!this.sid) {
      return
    }

    const title = `/${name}${arg ? ` ${arg}` : ''}`

    try {
      const r = await this.#gw.request<unknown>('slash.exec', { command: text.slice(1), session_id: this.sid })

      await this.#dispatched(r, title, arg)
    } catch (error) {
      // Only "slash.exec does not own this command" (skills, bundles) falls through to command.dispatch;
      // re-dispatching any other refusal could run a mutating command twice.
      if (isUnsupportedCommand(error) || !shouldFallbackToDispatch(error)) {
        this.transcript.notice(describeSlashExecError(name, error), isUnsupportedCommand(error) ? 'warning' : 'error')
      } else {
        try {
          await this.#dispatched(
            await this.#gw.request<unknown>('command.dispatch', { arg, name, session_id: this.sid }),
            title,
            arg
          )
        } catch (dispatchError) {
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

    interruptTurn(this.#gw, this.sid).catch(() => undefined)
    this.changed()
  }

  /** The gateway-backed turn controls' view of this app (/steer, /queue, /stop, /tools). */
  control(): ControlHost {
    return {
      busy: Boolean(this.busy),
      enqueue: text => {
        this.queue.push(text)
        this.changed()
      },
      gw: this.#gw,
      notice: (text, tone) => this.transcript.notice(text, tone),
      sid: this.sid,
      submit: text => this.#submit(text)
    }
  }

  #startBusy(label: string) {
    this.busy = { label, since: {}, startedAt: Date.now() }
    this.changed()
  }

  // ── Sessions ───────────────────────────────────────────────────────

  /** The first session: HERMES_TUI_RESUME's, else a new one; then the launcher's startup image, if any. */
  async #bootstrap() {
    const resume = process.env.HERMES_TUI_RESUME?.trim()

    try {
      await (resume ? this.resume(resume) : this.newSession())
    } catch (error) {
      this.transcript.notice(
        `Could not start a session: ${error instanceof Error ? error.message : String(error)}`,
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
        this.#attachments.push(await uploadImage(this.#gw, sid, path, process.env.HERMES_CWD || process.cwd()))
      } else {
        await this.#gw.request('image.attach', { path, session_id: sid })
      }
    } catch (error) {
      this.transcript.notice(
        `Could not attach ${path}: ${error instanceof Error ? error.message : String(error)}`,
        'warning'
      )
    }

    this.#startupImage = ''
    this.#drainQueue()
    this.changed()
  }

  /** After a reconnect: resumes the shown session in the new backend (its runtime id died with the old one). */
  async #reattach(id: string) {
    try {
      if (await this.#resume(id)) {
        this.transcript.notice('Reconnected to the agent backend.')
      }
    } catch (error) {
      this.transcript.notice(
        `Could not reattach the session: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      )
    }

    this.changed()
  }

  /** Closes the open session and starts a fresh one with an empty transcript. */
  async newSession() {
    const token = this.#switches.begin()

    try {
      const setup = await this.#gw.request<{ provider_configured?: boolean | null }>('setup.status', {})

      if (!this.#switches.current(token)) {
        return
      }

      if (setup?.provider_configured === false) {
        this.transcript.notice('No model provider is configured. Run `hermes setup`, then start again.', 'warning')

        return
      }

      if (this.sid) {
        await this.#leave(this.sid, 'tui_close')
      }

      const cwd = process.env.HERMES_TUI_CWD?.trim()

      // The shared gateway takes the launch flags (`hermes tern -m … --yolo -s …`) as the session's creation policy.
      const r = await this.#gw.request<CreateResult>(
        'session.create',
        this.#gw.isCanonical
          ? { ...localCreationOptions(), ...(cwd ? { cwd } : {}) }
          : { cols: this.#tern.caps.cols, ...(cwd ? { cwd } : {}) }
      )

      if (!this.#switches.current(token)) {
        // A later switch won; nothing will ever show this session.
        this.#subscribe(r)
        void this.#leave(r.session_id, 'tui_close')

        return
      }

      this.transcript.clear()
      this.transcript.push({ id: this.transcript.id('w'), kind: 'welcome' })
      this.#adopt(r)
    } finally {
      this.#settle(token)
    }
  }

  /** Resumes stored session `id`: its history replaces the transcript, and the session it leaves is closed. */
  async resume(id: string) {
    if (this.busy) {
      this.transcript.notice('Wait for the current turn to finish (or press Esc) before switching sessions.', 'warning')
      this.changed()

      return
    }

    const previous = this.sid
    const r = await this.#resume(id)

    if (r && previous && previous !== r.session_id) {
      void this.#leave(previous, 'tui_close')
    }
  }

  /** Resumes and adopts stored session `id`; undefined when a later switch superseded this one. */
  async #resume(id: string): Promise<CreateResult | undefined> {
    const token = this.#switches.begin()
    // Frames for `id` that beat the snapshot wait, then replay only what the snapshot lacks.
    const hold = this.#gw.holdAttach(id)
    let snapshot: CreateResult | undefined

    try {
      const r = await this.#gw.request<CreateResult>('session.resume', { cols: this.#tern.caps.cols, session_id: id })

      if (!this.#switches.current(token)) {
        this.#subscribe(r)
        void this.#leave(r.session_id, 'tui_close')

        return undefined
      }

      this.transcript.clear()
      this.transcript.push({ id: this.transcript.id('w'), kind: 'welcome' })
      this.#adopt(r)
      snapshot = r
      // An approval or question already waiting on the session opens its sheet.
      this.#gw.hydrateSharedPrompts(r)

      return r
    } finally {
      this.#gw.settleAttach(hold, snapshot)
      this.#settle(token)
    }
  }

  #adopt(r: CreateResult) {
    this.#subscribe(r)
    this.sid = r.session_id
    this.storedSid = r.info?.stored_session_id || r.stored_session_id || null
    writeActiveSessionFile(this.storedSid ?? r.session_id)
    this.info = r.info ?? this.info
    this.usage = r.info?.usage ?? null
    // A resumed session may be mid-turn: Esc stops it and new prompts queue behind it.
    this.busy = busyFrom(r)
    this.transcript.usageBase(r.info?.usage ?? undefined)

    if (r.messages?.length) {
      this.transcript.load(r.messages)
    }

    if (r.inflight) {
      this.transcript.inflight(r.inflight, this.busy?.startedAt)
    }

    this.changed()
  }

  #subscribe(r: CreateResult) {
    if (r.subscription_id) {
      this.#subscriptions.set(r.session_id, r.subscription_id)
    }
  }

  /** Stops showing session `sid`: a shared-gateway view detaches (the session keeps running for its other viewers); a private gateway closes it. */
  async #leave(sid: string, endReason: 'tui_close' | 'tui_shutdown') {
    const subscription = this.#subscriptions.get(sid)

    if (!this.#gw.isCanonical) {
      await this.#gw.request('session.close', { session_id: sid }).catch(() => undefined)

      return
    }

    if (!subscription) {
      return
    }

    this.#subscriptions.delete(sid)
    await this.#gw
      .request('session.detach', { end_reason: endReason, session_id: sid, subscription_id: subscription })
      .catch(() => undefined)
  }

  /** Acts on a slash.exec / command.dispatch answer: output, a skill or message to send, an alias or a prefill. */
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
          ? this.#send(d.message, { display: d.display || title })
          : this.transcript.notice(`${title}: the skill sent no message`, 'error')

      case 'send':
        if (d.notice?.trim()) {
          this.transcript.notice(d.notice)
        }

        return d.message?.trim() ? this.#send(d.message, { display: d.display }) : undefined

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
        this.#applySkin(ev.payload?.skin)
        // A reconnect's ready reattaches the shown session; only a sessionless app bootstraps.
        void (this.storedSid ? this.#reattach(this.storedSid) : this.#bootstrap())

        break

      case 'skin.changed':
        this.#applySkin(ev.payload)

        break

      case 'session.info':
        // The shared owner's idle fanout carries only pending/revision/generation: merge, never replace.
        this.info = ev.payload ? { ...this.info, ...ev.payload } : this.info
        this.usage = ev.payload?.usage ?? this.usage

        break

      case 'session.usage':
        this.usage = ev.payload?.usage ?? this.usage

        break

      case 'session.title':
        if (ev.payload?.title) {
          // eslint-disable-next-line no-control-regex -- a title must not end the OSC early
          process.stdout.write(`\x1b]2;${ev.payload.title.replace(/[\x00-\x1f]/g, ' ')}\x07`)
        }

        break

      case 'message.start':
        if (!this.busy) {
          this.#startBusy('Working…')
        }

        t.start()

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

      case 'thinking.delta':
        this.#label(kaomojiLabel(ev.payload?.text ?? ''))

        break

      case 'message.interim':
        t.interim(ev.payload?.text ?? '', { alreadyStreamed: Boolean(ev.payload?.already_streamed) })

        break

      case 'tool.generating':
        this.#label(`Preparing ${ev.payload?.name ?? 'a tool'}…`)

        break

      case 'tool.start':
        if (ev.payload) {
          t.toolStart(ev.payload)
          this.#label(`Running ${ev.payload.name}…`)
        }

        break

      case 'tool.complete':
        if (ev.payload) {
          t.toolComplete(ev.payload)
        }

        break

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

        break

      case 'message.complete':
        t.complete(ev.payload ?? {})
        this.busy = null
        this.#drainQueue()

        break

      case 'status.update':
        if (this.busy && ev.payload?.text && ev.payload.kind === 'status') {
          this.#label(ev.payload.text)
        }

        break

      case 'notice':
        t.notice(ev.payload?.message ?? '')

        break

      case 'error':
        t.notice(ev.payload?.message ?? 'error', 'error')

        break

      case 'gateway.start_timeout':
        t.notice('The agent backend did not start in time.', 'error')

        break

      case 'gateway.protocol_error':
        t.notice(`Protocol error from the agent backend: ${ev.payload?.preview ?? ''}`, 'error')

        break

      case 'background.complete':

      case 'btw.complete':
        if (ev.payload && 'text' in ev.payload && typeof ev.payload.text === 'string' && ev.payload.text.trim()) {
          t.panel(ev.type === 'btw.complete' ? '/btw' : 'Background task', ev.payload.text)
        }

        break

      case 'request.cancel':
        this.#heldRequests = this.#heldRequests.filter(r => r.id !== ev.payload?.id)
        this.#dropPrompts(key => key === `prompt:${ev.payload?.id}`)

        break

      case 'approval.request':

      case 'clarify.request': {
        const req = sharedPromptRequest(ev, this.#gw, message => {
          t.notice(message, 'error')
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

  #applySkin(skin: SkinPayload | null | undefined) {
    if (skin) {
      this.#surface.palette(paletteOf(skin))
    }
  }

  #label(label: string) {
    if (this.busy && label) {
      this.busy.label = label
    }
  }

  /** Steps the session's reasoning effort up hermes's ladder; session.info echoes it back. */
  #cycleEffort() {
    if (!this.sid) {
      return
    }

    const at = EFFORTS.indexOf(this.info?.reasoning_effort ?? '')
    const value = EFFORTS[at < 0 ? EFFORTS.indexOf('medium') : (at + 1) % EFFORTS.length]!
    // Shown at once (and a quick second press steps from it); session.info confirms.
    this.info = this.info && { ...this.info, reasoning_effort: value }
    this.changed()
    this.#gw.request('config.set', { key: 'reasoning', session_id: this.sid, value }).catch((error: Error) => {
      this.transcript.notice(error.message, 'error')
      this.changed()
    })
  }

  /** Alt+Up / the queue's Edit: the oldest queued prompt back into an empty composer. */
  #dequeue() {
    const next = this.queue.shift()

    if (next !== undefined) {
      this.composer.set(this.composer.text ? `${next}\n${this.composer.text}` : next)
      this.changed()
    }
  }

  /** Sends the oldest queued prompt once the session is adopted and idle (no turn, switch or startup image pending). */
  #drainQueue() {
    if (this.busy || !this.sid || this.#switches.pending || this.#startupImage) {
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
        composer: this.composer,
        context: max > 0 ? { max, used } : undefined,
        cost: usage?.cost_usd ?? undefined,
        cwd: info?.cwd ? shortPath(info.cwd) : '',
        effort: info?.reasoning_effort ?? '',
        ghost: modal ? '' : this.#completion.ghost,
        inputId: INPUT_ID,
        model: info?.model ?? '',
        now,
        onContext: () => void this.#slash('/usage'),
        onEdit: ev => {
          this.composer.edit(ev)
          this.changed()
        },
        onEffort: () => this.#cycleEffort(),
        onInterrupt: () => this.#interrupt(),
        onModel: () => openModelPicker(this),
        onQueueEdit: () => this.#dequeue(),
        onSend: ev => {
          this.#submit(ev.text)
          this.changed()
        },
        onSubmit: () => {
          this.#submit(this.composer.take())
          this.changed()
        },
        onUndo: () => {
          this.composer.undo()
          this.changed()
        },
        placeholder: 'Ask Hermes — / commands · @ files',
        queued: this.queue,
        ready: this.sid !== null
      }),
      layer: [...this.overlays.map(o => o.node(`layer.${o.key}`)), ...(modal ? [] : this.#completion.nodes(INPUT_ID))],
      main: this.transcript.entries.map(e => entryNode(e, `main.${e.id}`, cx))
    })

    // The top overlay's field holds the caret; a modal sheet without one takes it from the composer.
    const top = this.overlays.at(-1)
    const focus = top?.focus ? top.focus(`layer.${top.key}`) : top?.modal ? null : INPUT_ID

    if (focus !== this.#focus) {
      this.#focus = focus
      this.#surface.focus(focus)
    }
  }
}

/** `( •_•)>⌐■-■ cogitating...` → `Cogitating…`: hermes's kawaii status without the face. */
function kaomojiLabel(text: string): string {
  const word = text.match(/([A-Za-z][A-Za-z ]*[A-Za-z])\.{2,}\s*$/)?.[1]

  return word ? `${word.charAt(0).toUpperCase()}${word.slice(1)}…` : ''
}

function shortPath(path: string): string {
  const home = process.env.HOME

  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

