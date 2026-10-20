// Which session the pane shows, and how it changes: the first session, a new one, a resume, a
// reattach after a reconnect or a replay gap, and the gateway going away. Each switch takes a
// token; a slow result whose switch a later one superseded is released, never shown. Server
// requests for another session wait while a switch is in flight (it may be the one being
// adopted), and once none is, the held ones open or drop and the queue drains.

import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import type { GatewayClient } from '@tui/gatewayClient.js'

import type { LaunchEnv } from '../config/env.js'
import { errorText } from '../core/errors.js'
import { durable, type DurableSessionId, isLive, type LiveSessionId, type StoredSessionId, storedSessionId } from '../core/ids.js'
import { type RequestRoute, Switches } from '../flow.js'
import { createParams } from '../hermes/create.js'
import type { PromptSheets } from '../prompts/sheets.js'
import type { Transcript } from '../transcript.js'
import type { SwitchGate } from '../turn/router.js'
import { rpc } from '../wire/rpc.js'

import { type Adoptable, adoptAll, type Snapshot } from './adopt.js'
import type { SessionState, SessionTicket } from './state.js'
import { type EndReason, SessionViews } from './views.js'

/** What the session lifecycle reaches of the app. */
export interface LifecycleHost {
  readonly gw: Pick<GatewayClient, 'holdAttach' | 'hydrateSharedPrompts' | 'isCanonical' | 'request' | 'settleAttach'>
  readonly state: SessionState
  readonly transcript: Pick<Transcript, 'notice'>
  readonly sheets: Pick<PromptSheets, 'dropShared'>
  /** The launcher's session to resume, and the folder a new session starts in. */
  readonly launch: Pick<LaunchEnv, 'resume' | 'sessionCwd'>
  /** The pane's width, which a private gateway lays its output out for. */
  cols(): number
  /** Whether the view may move to another session now (not while a turn or a compaction runs). */
  canSwitch(): SwitchGate
  /** The launcher's --image still waits for the first session. */
  awaitingStartup(): boolean
  /** Attaches the launcher's image to session `sid`, then lets the startup query go. */
  attachStartup(sid: LiveSessionId): Promise<void>
  /** Names session `sid` (`/new <title>`). */
  rename(sid: LiveSessionId, title: string): Promise<void>
  /** Shows a server request (its sheet), routing it again first. */
  request(req: ServerRequest): void
  /** Sends the oldest held prompt, if the session is idle. */
  drain(): void
  /** Asks for a render. */
  changed(): void
}

/** The shown session's lifecycle: switches, the views this pane holds, and requests held across a switch. */
export class SessionLifecycle {
  readonly #host: LifecycleHost
  /** What an adopt runs, in order (session/adopt.ts). */
  readonly #steps: readonly Adoptable[]
  readonly #switches = new Switches()
  /** The sessions this pane views: its subscriptions, detaches in flight, and superseded switches' results. */
  readonly #views: SessionViews
  /** Server requests for another session, kept while a switch is in flight. */
  #heldRequests: ServerRequest[] = []

  constructor(host: LifecycleHost, steps: readonly Adoptable[]) {
    this.#host = host
    this.#steps = steps
    this.#views = new SessionViews(host.gw)
  }

  /** Whether a session switch is in flight: prompts and the queue wait for the session it adopts. */
  get switching(): boolean {
    return this.#switches.pending
  }

  /**
   * A ticket for a reply to the shown session (a slash command's): stale once the view left it, or
   * while a switch begun since is in flight (Ink's stale()).
   */
  replyTicket(): SessionTicket {
    const session = this.#host.state.ticket()
    const since = this.#switches.since()

    return {
      isCurrent: () => session.isCurrent() && !(this.#switches.pending && !since.isCurrent()),
      signal: session.signal,
      sid: session.sid
    }
  }

  /** gateway.ready: a reconnect's reattaches the shown session; only a sessionless app bootstraps. */
  ready() {
    const { stored } = this.#host.state.ref

    void (stored ? this.reattach(stored) : this.#bootstrap())
  }

  /** The gateway went away: the runtime session died with it, and nothing can answer the held requests. */
  lost() {
    const { state } = this.#host
    // Prompts queue until the next gateway.ready reattaches.
    state.ref = { live: null, stored: state.ref.stored }
    this.#heldRequests = []
  }

  /**
   * session.replay_gap for `sessionId`: the view fell behind and the owner retired its subscription
   * (the socket is fine, so no reconnect re-attaches it). A fresh resume brings the snapshot and a
   * new subscription.
   */
  fellBehind(sessionId: string | undefined) {
    const ref = this.#host.state.ref

    if (isLive(ref) && sessionId === ref.live) {
      void this.reattach(durable(ref), 'Reloaded the session: this view fell behind its events.')
    }
  }

  /** Routes a server request: another session's waits while a switch is in flight (held here), or drops. */
  route(req: ServerRequest): RequestRoute {
    const route = this.#switches.route(this.#host.state.ref.live, req.params.session_id)

    if (route === 'hold') {
      this.#heldRequests.push(req)
    }

    return route
  }

  /** request.cancel for request `id`: true when it was held here (it is dropped). */
  unhold(id: unknown): boolean {
    const held = this.#heldRequests.some(r => r.id === id)
    this.#heldRequests = this.#heldRequests.filter(r => r.id !== id)

    return held
  }

  /** Leaves every session this pane holds a subscription to (quitting). */
  leaveAll(endReason: EndReason): Promise<unknown> {
    return this.#views.leaveAll(endReason)
  }

  /** The first session: HERMES_TUI_RESUME's, else a new one; then the launcher's startup image, if any. */
  async #bootstrap() {
    const host = this.#host
    const resume = host.launch.resume

    try {
      await (resume ? this.resume(storedSessionId(resume)) : this.newSession())
    } catch (error) {
      host.transcript.notice(`Could not start a session: ${errorText(error)}`, 'error')
      host.changed()

      return
    }

    const sid = host.state.ref.live

    if (sid && host.awaitingStartup()) {
      await host.attachStartup(sid)
    }
  }

  /** After a reconnect (or a replay gap): resumes the shown session under `id` (its runtime id or subscription died). */
  async reattach(id: DurableSessionId, notice = 'Reconnected to the agent backend.') {
    const host = this.#host

    try {
      if (await this.reload(id)) {
        host.transcript.notice(notice)
      }
    } catch (error) {
      host.transcript.notice(`Could not reattach the session: ${errorText(error)}`, 'error')
    }

    host.changed()
  }

  /** Closes the open session and starts a fresh one with an empty transcript, named `title` if given. */
  async newSession(title?: string) {
    if (this.#refuseSwitch()) {
      return
    }

    const host = this.#host
    const previous = host.state.ref.live
    const token = this.#switches.begin()

    try {
      const setup = await rpc(host.gw, 'setup.status', {})

      if (!this.#switches.current(token)) {
        return
      }

      if (setup?.provider_configured === false) {
        host.transcript.notice('No model provider is configured. Run `hermes setup`, then start again.', 'warning')

        return
      }

      const r: Snapshot = await rpc(
        host.gw,
        'session.create',
        createParams({ canonical: host.gw.isCanonical, cols: host.cols(), cwd: host.launch.sessionCwd })
      )

      if (!this.#switches.current(token)) {
        // A later switch won; nothing will ever show this session.
        this.#views.superseded(r)

        return
      }

      this.#adopt(r)

      // Only now: a failed create leaves the view on the session it still receives.
      if (previous && previous !== r.session_id) {
        void this.#views.leave(previous, 'tui_close')
      }
    } finally {
      this.#settle(token)
    }

    const sid = host.state.ref.live

    if (title && sid) {
      await host.rename(sid, title)
    }
  }

  /** Resumes stored session `id`: its history replaces the transcript, and the session it leaves is closed. */
  async resume(id: StoredSessionId) {
    if (this.#refuseSwitch()) {
      return
    }

    const previous = this.#host.state.ref.live
    const r = await this.reload(id)

    if (r && previous && previous !== r.session_id) {
      void this.#views.leave(previous, 'tui_close')
    }
  }

  /**
   * Resumes and adopts session `id` (its stored id, or a runtime id when none is known); undefined
   * when a later switch superseded this one.
   */
  async reload(id: DurableSessionId): Promise<Snapshot | undefined> {
    const host = this.#host
    const token = this.#switches.begin()
    // Frames for `id` that beat the snapshot wait, then replay only what the snapshot lacks.
    const hold = host.gw.holdAttach(id)
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

      const r: Snapshot = await rpc(host.gw, 'session.resume', { cols: host.cols(), session_id: id })

      if (!this.#switches.current(token)) {
        this.#views.superseded(r)

        return undefined
      }

      this.#adopt(r)
      snapshot = r
      // An approval or question already waiting on the session opens its sheet. A sheet from before
      // the reattach may have been answered or pruned meanwhile (its settled event is not replayed).
      host.sheets.dropShared()
      host.gw.hydrateSharedPrompts(r)

      return r
    } finally {
      host.gw.settleAttach(hold, snapshot)
      this.#settle(token)
    }
  }

  /**
   * Refuses a session switch while a turn or a compaction runs (its queue and prompts belong to this
   * session); true when refused.
   */
  #refuseSwitch(): boolean {
    const host = this.#host
    const gate = host.canSwitch()

    if (gate.kind === 'switch') {
      return false
    }

    host.transcript.notice(gate.notice, 'warning')
    host.changed()

    return true
  }

  /**
   * Takes on snapshot `r`: its ids (and the shared gateway's subscription), then each adopt step in
   * order (one resets the transcript).
   */
  #adopt(r: Snapshot) {
    const ref = this.#views.adopt(r)

    adoptAll(this.#steps, { previous: this.#host.state.ref, r, ref })
  }

  /**
   * Ends switch `token`. Once none is in flight, in this order: what superseded switches attached is
   * released, the held requests open (or drop), the queue drains, and the pane renders.
   */
  #settle(token: number) {
    const host = this.#host
    this.#switches.end(token)

    if (this.#switches.pending) {
      return
    }

    this.#views.release(host.state.ref.live)
    const held = this.#heldRequests
    this.#heldRequests = []

    for (const req of held) {
      host.request(req)
    }

    host.drain()
    host.changed()
  }
}
