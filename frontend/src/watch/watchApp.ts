// One subagent in a pane of its own (the sidebar): its transcript drawn like the main chat's,
// live while it runs, with a composer that steers it. The transcript is the child's stored
// session (watch/child.ts); the live state is the owner's `subagent.list` row and the child's
// live log, as in the agents hub. Steering and stopping go through the delegating session.

import { readFile } from 'node:fs/promises'

import type { Key, Session, Surface, TspEvent } from '@stencil-hq/tern'
import type { GatewayClient } from '@tui/gatewayClient.js'
import type { AnyGatewayEvent } from '@tui/gatewayTypes.js'

import { parseLiveLog } from '../agents/liveLog.js'
import { applyLog, isRunning } from '../agents/store.js'
import { Composer } from '../composer.js'
import type { Subagent } from '../model.js'
import { paletteFor } from '../palette.js'
import { loadSettings } from '../settings.js'
import { Transcript } from '../transcript.js'
import { dockNodes } from '../view/dock.js'
import { STYLES } from '../view/styles.js'
import { agentNode } from '../view/tools.js'
import { entryNode } from '../view/transcript.js'

import { ChildStore } from './child.js'
import type { WatchSpec } from './spec.js'

const INPUT_ID = 'dock.composer.line.input'
const POLL_MS = 1000
const EXIT_ARM_MS = 1500

interface ListRow {
  subagent_id?: string
  model?: string | null
  status?: string
  tool_count?: number
  last_tool?: string | null
  accepting_steer?: boolean
  started_at?: number
}

export class WatchApp {
  readonly transcript = new Transcript()
  readonly composer = new Composer()
  readonly #tern: Session
  readonly #gw: GatewayClient
  readonly #spec: WatchSpec
  readonly #agent: Subagent
  #store: ChildStore | undefined
  #child: string | undefined
  #lastMessage = 0
  #logSize = -1
  #listed = false
  #ready = false
  #surface!: Surface
  #timer: NodeJS.Timeout | undefined
  #scheduled = false
  #exitArmed = 0
  #done = Promise.withResolvers<number>()

  constructor(tern: Session, gw: GatewayClient, spec: WatchSpec) {
    this.#tern = tern
    this.#gw = gw
    this.#spec = spec
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
    this.#surface = this.#tern.open({ id: 'hermes', mode: 'inline', role: 'omp.session', title: this.#spec.name })
    this.#surface.stylesheet('hermes-tern', STYLES)
    this.#surface.palette(paletteFor(loadSettings().theme ?? 'tern', undefined))
    this.#gw.on('event', (ev: AnyGatewayEvent) => {
      if (ev.type === 'gateway.ready') {
        this.#ready = true
        void this.#tick()
      }
    })
    this.#gw.drain()

    try {
      this.#store = new ChildStore()
    } catch (error) {
      this.transcript.notice(`The session database is not readable here: ${String(error)}`, 'warning')
    }

    this.#timer = setInterval(() => void this.#tick(), POLL_MS)
    void this.#tick()
    this.#render()
    this.#surface.focus(INPUT_ID)
    void this.#readInput()

    const code = await this.#done.promise
    clearInterval(this.#timer)
    this.#store?.close()
    await this.#tern.close()
    this.#gw.kill('exit')

    return code
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

    // Once it ended and the stored transcript caught up, nothing else will change.
    if (!isRunning(a) && this.#child && this.#timer) {
      clearInterval(this.#timer)
      this.#timer = undefined
    }
  }

  async #poll(): Promise<boolean> {
    const a = this.#agent

    try {
      const r = await this.#gw.request<{ subagents?: ListRow[] }>('subagent.list', { session_id: this.#spec.sid })
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

      return true
    } catch {
      return false
    }
  }

  async #readInput() {
    try {
      for await (const input of this.#tern) {
        if (input.type === 'key') {
          this.#onKey(input.key)
        } else {
          this.#onEvent(input.event)
        }

        this.changed()
      }
    } catch {
      // The pane went away.
    }

    this.#done.resolve(0)
  }

  #onEvent(ev: TspEvent) {
    if (ev.ev === 'focus' && ev.id === INPUT_ID) {
      this.#surface.focus(INPUT_ID)
    }

    // As in the main chat: what opens keeps its head in view.
    if (ev.ev === 'toggle' && !ev.collapsed && ev.id.startsWith('main.')) {
      this.#surface.reveal(ev.id, 'start')
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
      const r = await this.#gw.request<{ status?: string }>('subagent.steer', {
        session_id: this.#spec.sid,
        subagent_id: a.id,
        text
      })
      this.transcript.notice(
        r?.status === 'queued' ? `Steering sent: it reaches ${a.name} after its current step.` : `${a.name} is not taking steering now.`,
        r?.status === 'queued' ? 'info' : 'warning'
      )
    } catch (error) {
      this.transcript.notice(error instanceof Error ? error.message : String(error), 'error')
    }

    this.changed()
  }

  async #stop() {
    const a = this.#agent

    if (!isRunning(a)) {
      return
    }

    try {
      const r = await this.#gw.request<{ found?: boolean }>('subagent.interrupt', {
        session_id: this.#spec.sid,
        subagent_id: a.id
      })
      this.transcript.notice(r?.found ? `Stopping ${a.name}…` : `${a.name} already finished.`, 'info')
    } catch (error) {
      this.transcript.notice(error instanceof Error ? error.message : String(error), 'error')
    }

    this.changed()
  }

  #render() {
    const now = Date.now()
    const a = this.#agent
    const running = isRunning(a)
    const cx = { copy: () => undefined, now, welcome: { tip: '', version: '' } }

    this.#surface.render({
      dock: dockNodes({
        branch: '',
        busy: running
          ? { label: a.tool ? `Running ${a.tool}…` : 'Working…', since: a, startedAt: a.startedAt }
          : undefined,
        composer: this.composer,
        cwd: '',
        effort: '',
        inputId: INPUT_ID,
        model: a.model ?? '',
        now,
        onEdit: ev => {
          this.composer.edit(ev)
          this.changed()
        },
        onEffort: () => undefined,
        onInterrupt: () => void this.#stop(),
        onModel: () => undefined,
        onQueueEdit: () => undefined,
        onSend: ev => {
          void this.#submit(ev.text)
          this.changed()
        },
        onSubmit: () => {
          void this.#submit(this.composer.take())
          this.changed()
        },
        onUndo: () => {
          this.composer.undo()
          this.changed()
        },
        placeholder: running ? `Steer ${a.name} — /stop ends it` : `${a.name} has finished`,
        queued: [],
        ready: running
      }),
      main: [
        // The agent row heads the pane: status, model, tools, timer, the step it runs.
        agentNode({ ...a, summary: undefined }, now),
        ...this.transcript.entries.map(e => entryNode(e, `main.${e.id}`, cx))
      ]
    })
  }
}
