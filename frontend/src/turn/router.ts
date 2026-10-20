// Where a prompt goes: sent now, through the busy path (steer, redirect or queue, as
// busy_input_mode says), behind a turn or a compaction, or held until a session is adopted. One
// router for the composer's prompts, a slash command's, the queue's drain and the session
// commands' sends. Each entry point keeps its own gate, named here: they read different parts of
// the session's state, and each is pinned by a test (WP23 merges them).

import type { GatewayClient } from '@tui/gatewayClient.js'

import { redirectTurn, steerTurn } from '../controlCommands.js'
import { type LiveSessionId, newInputId } from '../core/ids.js'
import type { Transcript } from '../transcript.js'
import { rpc } from '../wire/rpc.js'

import type { Activity } from './activity.js'
import { EXPANDING_LABEL, expand, type Expanded, needsExpansion } from './expand.js'
import { IMAGE_ONLY_PROMPT, type Prompt, shownText, userImages } from './prompt.js'
import type { PromptQueue } from './queue.js'
import type { BusyMode } from './serverQueue.js'

/** What the gates read: the shown session's state when a prompt arrives. */
export interface GateState {
  /** The session's runtime id; null before the first session and while the gateway is down. */
  sid: LiveSessionId | null
  /** A session switch is in flight: the prompt belongs to the session it adopts. */
  switching: boolean
  /** A turn runs, or a send's `{!cmd}`s do. */
  busy: boolean
  /** A compaction runs. */
  compacting: boolean
  /** The launcher's --image still waits for the first session. */
  awaitingStartup: boolean
  /** The gateway is Hermes' shared one, whose queue admits a prompt at once. */
  canonical: boolean
}

/** Where a turn-time prompt goes: the busy path, behind the compaction, or sent now. */
export type TurnGate = 'busy' | 'behind' | 'send'

/** Where a typed prompt goes: also held, before the first session or during a switch. */
export type SubmitGate = 'hold' | TurnGate

/** Where a prompt behind the turn goes: held here, or admitted into session `sid`'s queue. */
export type BehindGate = { kind: 'hold' } | { kind: 'admit'; sid: LiveSessionId }

/** Whether a prompt can be sent now in session `sid`, or waits at the queue's head. */
export type SendGate = { kind: 'hold' } | { kind: 'send'; sid: LiveSessionId }

/** A slash command's prompt (a skill, a `send`): while a turn runs it takes the busy path a typed one does. */
export function gateTurn(s: GateState): TurnGate {
  if (s.busy) {
    return 'busy'
  }

  // /compress holds the session: the prompt waits behind it (no turn runs, so none to steer).
  if (s.compacting) {
    return 'behind'
  }

  return 'send'
}

/** A prompt the composer (or the app through it) sends: held until a session is adopted, then as gateTurn. */
export function gateSubmit(s: GateState): SubmitGate {
  if (!s.sid || s.switching) {
    return 'hold'
  }

  return gateTurn(s)
}

/** A prompt behind the turn: a private gateway, no session or a switch holds it here; the shared one admits it. */
export function gateBehind(s: GateState): BehindGate {
  if (!s.canonical || !s.sid || s.switching) {
    return { kind: 'hold' }
  }

  return { kind: 'admit', sid: s.sid }
}

/** A send: with no session, or a switch in flight, the prompt waits at the queue's head. */
export function gateSend(s: GateState): SendGate {
  if (!s.sid || s.switching) {
    return { kind: 'hold' }
  }

  return { kind: 'send', sid: s.sid }
}

/** Whether the oldest held prompt may go: the session is adopted and idle (no turn, compaction, switch or startup image). */
export function gateDrain(s: GateState): boolean {
  return !(s.busy || s.compacting || !s.sid || s.switching || s.awaitingStartup)
}

/** Which gate a prompt passes: a typed prompt's (gateSubmit), or a slash command's (gateTurn). */
export type Entry = 'typed' | 'command'

/** What the router reaches of the app. */
export interface RouterHost {
  readonly gw: Pick<GatewayClient, 'request'>
  readonly activity: Activity
  readonly queue: PromptQueue
  readonly transcript: Pick<Transcript, 'notice' | 'steer' | 'user'>
  /** The session's state, for the gates. */
  gates(): GateState
  /** Puts a prompt that did not go back into the composer. */
  restore(prompt: Prompt): void
  /** Asks for a render. */
  changed(): void
}

/** How a prompt is sent: `display` is what the transcript shows; `queued` marks a drained queue entry. */
export interface SendOptions {
  display?: string | undefined
  queued?: boolean
}

/** Routes each prompt through its entry point's gate. */
export class PromptRouter {
  readonly #host: RouterHost

  constructor(host: RouterHost) {
    this.#host = host
  }

  /** Sends, queues or holds `prompt` as its entry's gate says; while a turn runs, as `mode` says. */
  route(prompt: Prompt, mode: BusyMode, entry: Entry) {
    const s = this.#host.gates()

    switch (entry === 'typed' ? gateSubmit(s) : gateTurn(s)) {
      case 'hold':
        return this.#host.queue.hold(prompt)

      case 'busy':
        return void this.#busyInput(prompt, mode)

      case 'behind':
        return this.behind(prompt)

      case 'send':
        return this.send(prompt)
    }
  }

  /**
   * A prompt entered while a turn runs, as Ink's handleBusyInput: `steer` injects it into the turn,
   * `interrupt` redirects the turn with it, `queue` puts it behind the turn. A steer or redirect
   * carries no images, and one the gateway refuses is queued instead.
   */
  async #busyInput(prompt: Prompt, mode: BusyMode) {
    const host = this.#host
    const { sid } = host.gates()

    if (!sid || mode === 'queue' || prompt.images.length) {
      return this.behind(prompt)
    }

    const ready = await this.expanded(sid, prompt)

    if (!ready || sid !== host.gates().sid) {
      return
    }

    const r = await (mode === 'steer' ? steerTurn : redirectTurn)(host.gw, sid, ready.text)

    if (sid !== host.gates().sid) {
      return
    }

    if (r.ok) {
      host.transcript.steer(shownText(prompt))
    } else {
      if (r.error) {
        host.transcript.notice(`${mode === 'steer' ? 'Steer' : 'Redirect'} failed: ${r.error}. Queued instead.`, 'warning')
      }

      this.behind(prompt)
    }

    host.changed()
  }

  /** Puts `prompt` behind the running turn: into the shared gateway's queue at once, else held here. */
  behind(prompt: Prompt) {
    const host = this.#host
    const gate = gateBehind(host.gates())

    if (gate.kind === 'hold') {
      host.queue.hold(prompt)
      host.queue.drain()

      return host.changed()
    }

    void host.queue.admit(gate.sid, prompt)
  }

  /** `prompt` with its `{!cmd}`s run (a typed prompt's); undefined when one failed (the prompt is back in the composer). */
  expanded(sid: string, prompt: Prompt): Promise<Expanded | undefined> {
    return expand(this.#host, sid, prompt)
  }

  /**
   * Sends `prompt` now; `queued` marks a drained queue entry (the gateway must queue it, never steer
   * with it). A typed prompt's `{!cmd}`s run first and their output takes their place; `display` is
   * what the transcript shows.
   */
  send(prompt: Prompt, { display = prompt.kind === 'command' ? prompt.display : undefined, queued = false }: SendOptions = {}) {
    const host = this.#host
    const gate = gateSend(host.gates())

    // A session switch in flight: the prompt belongs to the session it adopts.
    if (gate.kind === 'hold') {
      host.queue.holdFirst(prompt)

      return
    }

    const { sid } = gate

    if (needsExpansion(prompt)) {
      // The expansion counts as busy: the working line says so, and nothing else is sent meanwhile.
      host.activity.startBusy(EXPANDING_LABEL)
      host.changed()
      void this.expanded(sid, prompt).then(ready => {
        host.activity.endBusy()

        if (ready) {
          this.send({ images: ready.images, kind: 'app', text: ready.text }, { display: prompt.text, queued })
        } else {
          // A command that could not run refuses the whole prompt: it is back in the composer to edit.
          host.queue.drain()
          host.changed()
        }
      })

      return
    }

    const { images } = prompt
    const text = prompt.text || (images.length ? IMAGE_ONLY_PROMPT : '')
    const attachments = images.map(({ mime, path }) => ({ mime, path }))
    const submission = newInputId()
    host.transcript.user({ attachments: userImages(images), text: display?.trim() || prompt.text })
    // Its bubble is up: the gateway's queued → started for it owes none.
    host.queue.server.shown(submission)
    host.activity.startBusy('Working…')
    host.changed()
    // The shared gateway admits a prompt by its submission id (a retry with the same id is one turn).
    rpc(host.gw, 'prompt.submit', {
      session_id: sid,
      submission_id: submission,
      text,
      ...(queued ? { queued } : {}),
      ...(attachments.length ? { attachments } : {})
    }).catch((error: Error) => {
      // Back to the composer, not re-sent: a timeout may come after the gateway admitted it.
      host.transcript.notice(`Not sent: ${error.message}. Your message is back in the composer.`, 'error')
      host.activity.endBusy()
      host.restore(prompt)
      host.queue.drain()
      host.changed()
    })
  }
}
