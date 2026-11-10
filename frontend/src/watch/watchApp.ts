// One subagent in a pane of its own (the sidebar): its transcript drawn like the main chat's,
// live while it runs, with a composer that steers it. This pane has its own gateway connection and
// does not attach the delegating session, so it hears none of its events. The transcript is the
// child's stored rows (`session.transcript` with its `subagent_id`, agents/transcript.ts), read
// every second until the child ended and the reads caught up; the live state (model, tool count,
// the tool it runs, steerability) is the owner's `subagent.list` row. Steering and stopping go
// through the delegating session.

import type { Key, Session, TspEvent } from '@stencil-hq/tern'
import type { GatewayClient } from '@hermes/shared/gateway-client'
import type { AnyGatewayEvent } from '@hermes/shared/gateway-types'

import { agentNode } from '../agents/agentRow.js'
import { isRunning } from '../agents/rows.js'
import { SubagentTranscript } from '../agents/transcript.js'
import { paletteFor } from '../chrome/palette.js'
import { errorText } from '../core/errors.js'
import { subagentKey } from '../core/ids.js'
import { Poller } from '../core/poller.js'
import { RenderScheduler } from '../core/scheduler.js'
import { Composer } from '../draft/composer.js'
import { Media } from '../media.js'
import type { Subagent } from '../model.js'
import { fileSettings, type SettingsSource } from '../settings.js'
import { INPUT_ID, SurfaceHost } from '../surface/host.js'
import { runInput } from '../surface/input.js'
import { Transcript } from '../transcript/store.js'
import { type DockActions, dockNodes } from '../view/dock.js'
import { STYLES } from '../view/styles.js'
import { noticeSink, onCardFault } from '../view/tools/faults.js'
import { entryNode } from '../view/transcript.js'
import { rpc } from '../wire/rpc.js'

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
  readonly #stored: SubagentTranscript
  /** A read of the transcript failed and the pane said so. */
  #readFailed = false
  #ready = false
  #surface!: SurfaceHost
  /** The poll: every second until the agent ended and its stored transcript caught up. */
  readonly #poller: Poller = new Poller({
    cadence: () => (this.#stored.finished ? 'off' : POLL_MS),
    run: () => this.#tick()
  })
  readonly #renders = new RenderScheduler(() => this.#render())
  #exitArmed = 0
  #done = Promise.withResolvers<number>()
  /** The dock's buttons: the composer steers the agent and Stop stops it; this pane has no pills, queue, chips or chips' sheets. */
  readonly #dock: DockActions = {
    onAgents: none,
    onDictate: none,
    onDictationCancel: none,
    onDictationDone: none,
    onBtwDismiss: none,
    onBtwView: none,
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
      key: subagentKey(spec.subagent),
      name: spec.name,
      startedAt: spec.startedAt,
      status: 'running',
      tokens: 0,
      toolCount: 0
    }
    this.#stored = new SubagentTranscript(gw, spec.sid, spec.subagent)
  }

  async run(): Promise<number> {
    this.#surface = new SurfaceHost(this.#tern, this.#spec.name, STYLES, {
      changed: () => this.changed(),
      recovered: () => this.#surface.guardHandlers(false),
      report: message => {
        process.stderr.write('hermes tern watch: ' + message + '\n')
        this.transcript.notice(message, 'error')
        this.changed()
        // Only terminal protocol/frame failures end the watcher; a stalled ACK
        // is diagnostic and must not create a timer-driven reopen or exit.
        if (this.#surface.state === 'failed') {
          this.#done.resolve(1)
        }
      }
    })
    this.#surface.guardHandlers(false)
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
    this.#surface.dispose()
    this.#poller.dispose()
    await this.#tern.close()
    this.#gw.kill('exit')

    return code
  }

  changed() {
    this.#renders.request()
  }

  async #tick() {
    if (!this.#ready) {
      return
    }

    let changed = false

    if (isRunning(this.#agent)) {
      changed = (await this.#poll()) || changed
    }

    changed = (await this.#readTranscript()) || changed

    if (changed) {
      this.changed()
    }
  }

  /** Folds the owner's `subagent.list` row into the agent row; true when there is one. */
  async #poll(): Promise<boolean> {
    const a = this.#agent

    try {
      const r = await rpc(this.#gw, 'subagent.list', { session_id: this.#spec.sid })
      const row = r?.subagents?.find(x => x.subagent_id === a.id)

      if (!row) {
        return false
      }

      a.model = row.model ?? a.model
      a.toolCount = Math.max(a.toolCount, row.tool_count ?? 0)
      a.steerable = row.accepting_steer ?? a.steerable
      a.startedAt = typeof row.started_at === 'number' ? row.started_at * 1000 : a.startedAt
      a.status = 'running'

      // The owner names the last tool started; while the stored rows lack its result, it runs.
      const tool = (row.tool_count ?? 0) > this.#storedTools() ? (row.last_tool ?? undefined) : undefined

      if (tool !== a.tool) {
        a.tool = tool
        a.toolSince = { at: Date.now() }
      }

      return true
    } catch {
      return false
    }
  }

  /** Reads the rows the child stored since the last read; at its end, the row says it ended. */
  async #readTranscript(): Promise<boolean> {
    const a = this.#agent
    let changed = false

    try {
      changed = await this.#stored.read()
    } catch (error) {
      // The next tick tries again; the pane says so once.
      if (this.#readFailed) {
        return false
      }

      this.#readFailed = true
      this.transcript.notice(`Could not read ${a.name}'s transcript: ${errorText(error)}`, 'warning')

      return true
    }

    if (changed) {
      this.transcript.load(this.#stored.rows)
      this.#media.showAll(this.transcript.entries, call => {
        this.transcript.touchCall(call)
        this.changed()
      })
    }

    // Nothing public says how a child ended to a pane that did not attach its parent: ended is done.
    if (this.#stored.running === false && isRunning(a)) {
      a.status = 'done'
      a.duration = Date.now() - a.startedAt
      a.tool = undefined
      changed = true
    }

    return changed
  }

  /** The tool calls the child's stored rows hold (each is stored with its result). */
  #storedTools(): number {
    return this.#stored.rows.filter(r => r.role === 'tool').length
  }

  async #readInput() {
    // A failure means the pane went away: it ends the loop quietly.
    await runInput(this.#tern, {
      after: () => this.changed(),
      onError: error => this.#surface.failure(new Error('Tern input failed: ' + errorText(error))),
      onEvent: event => this.#onEvent(event),
      onKey: key => this.#onKey(key)
    })
    this.#done.resolve(0)
  }

  #onEvent(ev: TspEvent) {
    if (!this.#surface.event(ev)) {
      return
    }
    if (ev.ev === 'focus' && ev.id === INPUT_ID) {
      this.#surface.focus(INPUT_ID)
    }
  }

  #onKey(key: Key) {
    if (this.#surface.state !== 'visible') {
      return
    }
    // These Ctrl keys clear or close the watcher; modified variants are not that intent.
    // Consume them here: Composer also treats Ctrl+Shift+D as delete-forward.
    if (key.ctrl && (key.name === 'c' || key.name === 'd') && (key.alt || key.meta || key.shift)) {
      return
    }
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
    if (this.#surface.closed) {
      return
    }
    try {
      this.#paint()
      this.#surface.rendered()
    } catch (error) {
      this.#surface.failure(error)
    }
  }

  #paint() {
    const now = Date.now()
    const a = this.#agent
    const running = isRunning(a)
    const cx = { copy: () => undefined, hour12: this.#tern.caps.hour12, now, welcome: { version: '' } }

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
          btwNotices: [],
          pills: {},
          queue: { canSteer: false, hint: '', rows: [] },
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
    // Reapply the editor caret only after the current document has rebuilt it.
    this.#surface.follow(INPUT_ID)
  }
}
