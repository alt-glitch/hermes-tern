// One subagent in a pane of its own (the sidebar): its transcript drawn like the main chat's,
// live while it runs, with a composer that steers it. The transcript is the child's stored
// session (watch/child.ts); the live state is the owner's `subagent.list` row and the child's
// live log, as in the agents hub. Steering and stopping go through the delegating session.

import { readFile } from 'node:fs/promises'

import type { Key, Session, TspEvent } from '@stencil-hq/tern'
import type { GatewayClient } from '@tui/gatewayClient.js'
import type { AnyGatewayEvent } from '@tui/gatewayTypes.js'

import { agentNode } from '../agents/agentRow.js'
import { parseLiveLog } from '../agents/liveLog.js'
import { applyLog, isRunning } from '../agents/rows.js'
import { Composer } from '../composer.js'
import { errorText } from '../core/errors.js'
import { Poller } from '../core/poller.js'
import { RenderScheduler } from '../core/scheduler.js'
import { Media } from '../media.js'
import type { Subagent } from '../model.js'
import { paletteFor } from '../palette.js'
import { fileSettings, type SettingsSource } from '../settings.js'
import { INPUT_ID, SurfaceHost } from '../surface/host.js'
import { runInput } from '../surface/input.js'
import { Transcript } from '../transcript.js'
import { type DockActions, dockNodes } from '../view/dock.js'
import { noticeSink, onCardFault } from '../view/tools/faults.js'
import { entryNode } from '../view/transcript.js'
import { rpc } from '../wire/rpc.js'

import { ChildStore } from './child.js'
import type { WatchSpec } from './spec.js'

const POLL_MS = 1000
const EXIT_ARM_MS = 1500

/** A dock button this pane does not show. */
const none = () => undefined

export class WatchApp {
  readonly transcript = new Transcript()
  readonly composer = new Composer()
  readonly #media = new Media({ blob: (bytes, mime) => (this.#tern.caps.features.includes('blobs') ? this.#tern.blob(bytes, mime) : undefined) })
  readonly #tern: Session
  readonly #gw: GatewayClient
  readonly #spec: WatchSpec
  readonly #agent: Subagent
  readonly #settings: SettingsSource
  #store: ChildStore | undefined
  #child: string | undefined
  #lastMessage = 0
  #logSize = -1
  #listed = false
  #ready = false
  #surface!: SurfaceHost
  /** The poll: every second until the agent ended and its stored transcript caught up. */
  readonly #poller: Poller = new Poller({
    cadence: () => (!isRunning(this.#agent) && this.#child ? 'off' : POLL_MS),
    run: () => this.#tick()
  })
  readonly #renders = new RenderScheduler(() => this.#render())
  #exitArmed = 0
  #done = Promise.withResolvers<number>()
  /** The dock's buttons: the composer steers the agent and Stop stops it; this pane has no pills, queue, chips or chips' sheets. */
  readonly #dock: DockActions = {
    onAgents: none,
    onEdit: ev => {
      this.composer.edit(ev)
      this.changed()
    },
    onEffort: none,
    onGoal: none,
    onInterrupt: () => void this.#stop(),
    onLoop: none,
    onModel: none,
    onPrs: none,
    onQueueEdit: none,
    onQueueSteer: none,
    onRemoveAttachment: none,
    onSend: ev => {
      void this.#submit(ev.text)
      this.changed()
    },
    onShells: none,
    onSubmit: () => {
      void this.#submit(this.composer.take())
      this.changed()
    },
    onTodos: none,
    onUndo: () => {
      this.composer.undo()
      this.changed()
    }
  }

  constructor(tern: Session, gw: GatewayClient, spec: WatchSpec, settings: SettingsSource = fileSettings()) {
    this.#tern = tern
    this.#gw = gw
    this.#spec = spec
    this.#settings = settings
    this.#agent = {
      calls: 0,
      goal: spec.goal,
      id: spec.subagent,
      index: spec.index,
      logPath: spec.log,
      name: spec.name,
      startedAt: spec.startedAt,
      status: 'running',
      tokens: 0,
      toolCount: 0
    }
  }

  async run(): Promise<number> {
    this.#surface = new SurfaceHost(this.#tern, this.#spec.name)
    const theme = this.#settings.load().theme ?? 'tern'
    this.#surface.palette(paletteFor(theme, undefined))
    this.#gw.on('event', (ev: AnyGatewayEvent) => {
      if (ev.type === 'gateway.ready') {
        this.#ready = true
        this.#poller.poke()
      }

      // In `skin` mode the watcher wears the skin the session does, as the main pane does.
      const skin = ev.type === 'gateway.ready' ? ev.payload?.skin : ev.type === 'skin.changed' ? ev.payload : undefined

      if (skin) {
        this.#surface.palette(paletteFor(theme, skin))
      }
    })
    this.#gw.drain()

    try {
      this.#store = new ChildStore()
    } catch (error) {
      this.transcript.notice(`The session database is not readable here: ${String(error)}`, 'warning')
    }

    // A card that throws draws as the generic one, and the pane says so once per tool name.
    onCardFault(
      noticeSink(text => {
        this.transcript.notice(text, 'warning')
        this.changed()
      })
    )
    this.#poller.poke()
    this.#render()
    this.#surface.focus(INPUT_ID)
    void this.#readInput()

    const code = await this.#done.promise
    this.#poller.dispose()
    this.#store?.close()
    await this.#tern.close()
    this.#gw.kill('exit')

    return code
  }

  changed() {
    this.#renders.request()
  }

  async #tick() {
    const a = this.#agent
    let changed = false

    if (this.#ready && isRunning(a)) {
      changed = (await this.#poll()) || changed
    }

    changed = (await this.#readLog()) || changed
    changed = this.#readTranscript() || changed

    if (changed) {
      this.changed()
    }
  }

  async #poll(): Promise<boolean> {
    const a = this.#agent

    try {
      const r = await rpc(this.#gw, 'subagent.list', { session_id: this.#spec.sid })
      const row = r?.subagents?.find(x => x.subagent_id === a.id)

      if (!row) {
        // Gone from the owner's registry: it ended; the log (when there is one) says how.
        if (this.#listed && !a.logPath) {
          a.status = 'done'
          a.duration = Date.now() - a.startedAt

          return true
        }

        return false
      }

      this.#listed = true
      a.model = row.model ?? a.model
      a.toolCount = Math.max(a.toolCount, row.tool_count ?? 0)
      a.steerable = row.accepting_steer ?? a.steerable
      a.startedAt = typeof row.started_at === 'number' ? row.started_at * 1000 : a.startedAt

      return true
    } catch {
      return false
    }
  }

  async #readLog(): Promise<boolean> {
    const path = this.#agent.logPath

    if (!path) {
      return false
    }

    try {
      const text = await readFile(path, 'utf8')

      if (text.length === this.#logSize) {
        return false
      }

      this.#logSize = text.length
      applyLog(this.#agent, parseLiveLog(text))

      return true
    } catch {
      return false
    }
  }

  #readTranscript(): boolean {
    const store = this.#store

    if (!store) {
      return false
    }

    try {
      this.#child ??= store.find([this.#spec.sid, this.#spec.stored ?? ''], this.#spec.goal, this.#spec.startedAt)

      if (!this.#child) {
        return false
      }

      const last = store.last(this.#child)

      if (last === this.#lastMessage) {
        return false
      }

      this.#lastMessage = last
      this.transcript.load(store.messages(this.#child))
      this.#media.showAll(this.transcript.entries, call => {
        this.transcript.touchCall(call)
        this.changed()
      })

      return true
    } catch {
      return false
    }
  }

  async #readInput() {
    // A failure means the pane went away: it ends the loop quietly.
    await runInput(this.#tern, { after: () => this.changed(), onEvent: event => this.#onEvent(event), onKey: key => this.#onKey(key) })
    this.#done.resolve(0)
  }

  #onEvent(ev: TspEvent) {
    if (ev.ev === 'focus' && ev.id === INPUT_ID) {
      this.#surface.focus(INPUT_ID)
    }
  }

  #onKey(key: Key) {
    if (key.ctrl && key.name === 'c') {
      if (this.composer.text) {
        this.composer.set('')

        return
      }

      const now = Date.now()

      if (now - this.#exitArmed < EXIT_ARM_MS) {
        return this.#done.resolve(0)
      }

      this.#exitArmed = now
      this.transcript.notice('Press Ctrl+C again to close this pane.')

      return
    }

    if (key.ctrl && key.name === 'd' && !this.composer.text) {
      return this.#done.resolve(0)
    }

    if (this.composer.key(key) === 'submit') {
      void this.#submit(this.composer.take())
    }
  }

  async #submit(raw: string) {
    const text = raw.trim()
    const a = this.#agent

    if (!text) {
      return
    }

    if (text === '/stop') {
      return this.#stop()
    }

    if (!isRunning(a)) {
      this.transcript.notice(`${a.name} has finished; there is nothing to steer.`, 'warning')

      return this.changed()
    }

    try {
      const r = await rpc(this.#gw, 'subagent.steer', {
        session_id: this.#spec.sid,
        subagent_id: a.id,
        text
      })
      this.transcript.notice(
        r?.status === 'queued' ? `Steering sent: it reaches ${a.name} after its current step.` : `${a.name} is not taking steering now.`,
        r?.status === 'queued' ? 'info' : 'warning'
      )
    } catch (error) {
      this.transcript.notice(errorText(error), 'error')
    }

    this.changed()
  }

  async #stop() {
    const a = this.#agent

    if (!isRunning(a)) {
      return
    }

    try {
      const r = await rpc(this.#gw, 'subagent.interrupt', {
        session_id: this.#spec.sid,
        subagent_id: a.id
      })
      this.transcript.notice(r?.found ? `Stopping ${a.name}…` : `${a.name} already finished.`, 'info')
    } catch (error) {
      this.transcript.notice(errorText(error), 'error')
    }

    this.changed()
  }

  #render() {
    const now = Date.now()
    const a = this.#agent
    const running = isRunning(a)
    const cx = { copy: () => undefined, now, welcome: { tip: '', version: '' } }

    this.#surface.render({
      dock: dockNodes(
        {
          activity: running ? { kind: 'turn', label: a.tool ? `Running ${a.tool}…` : 'Working…', since: a, startedAt: a.startedAt } : { kind: 'idle' },
          composer: {
            attachments: [],
            draft: this.composer,
            placeholder: running ? `Steer ${a.name} — /stop ends it` : `${a.name} has finished`,
            ready: running
          },
          now,
          pills: {},
          queue: { canSteer: false, rows: [] },
          route: { effort: '', model: a.model ?? '' },
          status: { branch: '' }
        },
        this.#dock
      ),
      main: [
        // The agent row heads the pane: status, model, tools, timer, the step it runs.
        agentNode({ ...a, summary: undefined }, now),
        ...this.transcript.entries.map(e => entryNode(e, `main.${e.id}`, cx))
      ]
    })
  }
}
