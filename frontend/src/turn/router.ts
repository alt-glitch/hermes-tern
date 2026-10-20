// Where a prompt goes: sent now, through the busy path (steer, redirect or queue, as
// busy_input_mode says), behind a turn or a compaction, or held until a session is adopted. One
// router for the composer's prompts, a slash command's, the queue's drain and the session
// commands' sends. Two gates read the session's state: canSend (where a prompt goes) and
// canSwitch (whether the view may move to another session); each entry point reads one of them.

import type { GatewayClient } from '@tui/gatewayClient.js'

import { redirectTurn, steerTurn } from '../controlCommands.js'
import { type LiveSessionId, newInputId } from '../core/ids.js'
import type { SessionTicket } from '../session/state.js'
import type { Transcript } from '../transcript.js'
import { rpc } from '../wire/rpc.js'

import type { Activity } from './activity.js'
import { EXPANDING_LABEL, expand, type Expanded, hasCommands } from './expand.js'
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

/** What the session is doing: a turn (it wins over a compaction inside it), a compaction, or nothing. */
type Doing = 'turn' | 'compaction' | 'nothing'

function doing(s: GateState): Doing {
  if (s.busy) {
    return 'turn'
  }

  return s.compacting ? 'compaction' : 'nothing'
}

/**
 * Where a prompt can go now. `hold`: no session yet, or a switch in flight (it belongs to the
 * session adopted next); `busy`: a turn runs (the busy path); `behind`: a compaction runs (no turn
 * to steer, so it waits behind it); `send`: the session is idle.
 */
export type SendGate =
  | { kind: 'hold' }
  | { kind: 'busy'; sid: LiveSessionId }
  | { kind: 'behind'; sid: LiveSessionId }
  | { kind: 'send'; sid: LiveSessionId }

/** Where a prompt can go now, read from the whole state once: every entry point asks here. */
export function canSend(s: GateState): SendGate {
  if (!s.sid || s.switching) {
    return { kind: 'hold' }
  }

  const { sid } = s

  switch (doing(s)) {
    case 'turn':
      return { kind: 'busy', sid }

    case 'compaction':
      return { kind: 'behind', sid }

    case 'nothing':
      return { kind: 'send', sid }
  }
}

/** Whether the oldest held prompt may go: the session can take a send, and no startup image waits. */
export function canDrain(s: GateState): boolean {
  return canSend(s).kind === 'send' && !s.awaitingStartup
}

/** Whether the view may move to another session: `wait` says why not. */
export type SwitchGate = { kind: 'switch' } | { kind: 'wait'; notice: string }

/**
 * A switch waits while a turn or a compaction runs: the prompts queued behind it, and its result,
 * are this session's. A switch in flight may be superseded by another.
 */
export function canSwitch(s: GateState): SwitchGate {
  switch (doing(s)) {
    case 'turn':
      return { kind: 'wait', notice: 'Wait for the current turn to finish (or press Esc twice) before switching sessions.' }

    case 'compaction':
      return { kind: 'wait', notice: 'Wait for the compaction to finish before switching sessions.' }

    case 'nothing':
      return { kind: 'switch' }
  }
}

/** What the router reaches of the app. */
export interface RouterHost {
  readonly gw: Pick<GatewayClient, 'request'>
  readonly activity: Activity
  readonly queue: PromptQueue
  readonly transcript: Pick<Transcript, 'notice' | 'steer' | 'user'>
  /** The session's state, for the gates. */
  gates(): GateState
  /** A ticket for the shown session, to check after an await. */
  ticket(): SessionTicket
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

/** Routes each prompt through the gates. */
export class PromptRouter {
  readonly #host: RouterHost

  constructor(host: RouterHost) {
    this.#host = host
  }

  /**
   * Sends, queues or holds `prompt` (a typed one, or a slash command's) as canSend says; while a
   * turn runs, as `mode` says.
   */
  route(prompt: Prompt, mode: BusyMode) {
    switch (canSend(this.#host.gates()).kind) {
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
    const ticket = host.ticket()
    const { sid } = ticket

    if (!sid || mode === 'queue' || prompt.images.length) {
      return this.behind(prompt)
    }

    const ready = await this.expanded(sid, prompt)

    if (!ready || !ticket.isCurrent()) {
      return
    }

    const r = await (mode === 'steer' ? steerTurn : redirectTurn)(host.gw, sid, ready.text)

    if (!ticket.isCurrent()) {
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
    const s = host.gates()
    const gate = canSend(s)

    // A private gateway has no queue to admit into: the prompt waits here.
    if (gate.kind === 'hold' || !s.canonical) {
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
    const gate = canSend(host.gates())

    // No session, or a switch in flight: the prompt belongs to the session it adopts. A turn or a
    // compaction does not stop it (a drained prompt, or one the busy path already chose to send).
    if (gate.kind === 'hold') {
      host.queue.holdFirst(prompt)

      return
    }

    const { sid } = gate

    if (prompt.kind === 'typed' && hasCommands(prompt)) {
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
