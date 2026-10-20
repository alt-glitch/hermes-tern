// The prompts waiting behind the turn, as one store: those this pane holds (no session yet, a
// switch in flight, a private gateway's busy turn, a compaction) and this pane's admissions into
// the shared gateway's queue, with the other viewers' rows of it. The dock's queued rows, Alt+Up
// and Edit (back into the composer), Alt+Enter and Steer (into the running turn) and the drain
// once the session is idle all act here. App decides when a prompt is held or admitted.
//
// A held prompt knows whom it waits for: whichever session is adopted next (none was shown, or a
// switch was in flight), or the session it was held in (behind its turn or its compaction). When
// another session is adopted, the second kind goes back to the composer, never to that session.

import { steerTurn } from '../controlCommands.js'
import { type LiveSessionId, newInputId, type SessionRef } from '../core/ids.js'
import { errorText } from '../core/errors.js'
import type { Image } from '../draft/attachments.js'
import type { NoticeEntry } from '../model.js'
import { internalNotice } from '../transcript/messages.js'
import type { SessionTicket } from '../session/state.js'
import type { QueuedRow } from '../view/queued.js'
import { admissionOf, type Requester, rpc } from '../wire/rpc.js'

import { IMAGE_ONLY_PROMPT, type Prompt, shownText, userText } from './prompt.js'
import { type OwnAdmission, ServerQueue, type ServerQueued } from './serverQueue.js'

/** A prompt this pane admitted into the shared gateway's queue: as entered (for Edit), and the text sent. */
export interface Admitted {
  prompt: Prompt
  sent: string
}

/** One of this pane's rows in the shared gateway's queue that the gateway named: it can be withdrawn. */
type Mine = Extract<ServerQueued<Admitted>, { kind: 'mine' }>

/** Whom a held prompt waits for: the session adopted next, or session `ref`, where it was held. */
export type HeldTarget = { kind: 'next' } | { kind: 'session'; ref: SessionRef }

/** The session adopted next. */
const NEXT: HeldTarget = { kind: 'next' }

/** A prompt held here, and whom it waits for. Each is made once, so it is its own id. */
interface Held {
  readonly prompt: Prompt
  readonly target: HeldTarget
}

/** Whether `target` waits for adopted session `ref`: the next one, or the same session (its runtime id, or its stored id across a reattach). */
function waitsFor(target: HeldTarget, ref: SessionRef): boolean {
  switch (target.kind) {
    case 'next':
      return true

    case 'session':
      return target.ref.live === ref.live || (target.ref.stored !== null && target.ref.stored === ref.stored)
  }
}

/** What the prompt queue reaches of the app. */
export interface QueueHost {
  readonly gw: Requester
  readonly transcript: {
    notice(text: string, tone?: NoticeEntry['tone']): void
    steer(text: string): void
  }
  /** A ticket for the shown session (its runtime id is null before the first one). */
  ticket(): SessionTicket
  /** A turn runs (Steer is offered, and acts). */
  busy(): boolean
  /** The session is adopted and idle: the oldest held prompt may go. */
  canDrain(): boolean
  /** Asks for a render. */
  changed(): void
  /** Puts a prompt that did not go back into the composer. */
  restore(prompt: Prompt): void
  /** Sends a drained prompt now (the gateway must queue it, never steer with it). */
  send(prompt: Prompt): void
  /** `prompt` with its `{!cmd}`s run; undefined when one failed (the host put it back in the composer). */
  expanded(sid: LiveSessionId, prompt: Prompt): Promise<{ images: Image[]; text: string } | undefined>
}

/** The prompts waiting behind the turn: held here, then the shared gateway's queue. */
export class PromptQueue {
  /** Prompts held here until they can be sent: no session yet, a switch in flight, or a private gateway's busy turn. */
  #held: Held[] = []
  /** The shared gateway's queue for this session: its FIFO, this pane's admissions, the bubbles they owe. */
  readonly server = new ServerQueue<Admitted>()
  readonly #host: QueueHost

  constructor(host: QueueHost) {
    this.#host = host
  }

  /** The held prompts, oldest first. */
  get held(): readonly Prompt[] {
    return this.#held.map(h => h.prompt)
  }

  /** Holds `prompt` behind the others, for `target` (the session adopted next by default). */
  hold(prompt: Prompt, target: HeldTarget = NEXT) {
    this.#held.push({ prompt, target })
  }

  /**
   * Holds `prompt` ahead of the others, for `target` (the session adopted next by default): a send
   * that found a switch in flight, or one a turn overtook while its `{!cmd}`s ran.
   */
  holdFirst(prompt: Prompt, target: HeldTarget = NEXT) {
    this.#held.unshift({ prompt, target })
  }

  /**
   * Session `ref` is adopted: the prompts held for another session go back to the composer, oldest
   * first, and a notice says so; those for the next session wait for the drain.
   */
  adopt(ref: SessionRef) {
    const gone = this.#held.filter(h => !waitsFor(h.target, ref))

    if (!gone.length) {
      return
    }

    this.#held = this.#held.filter(h => waitsFor(h.target, ref))

    // Each restore goes before the composer's text: the newest first leaves the oldest on top.
    for (const h of gone.toReversed()) {
      this.#host.restore(h.prompt)
    }

    const n = gone.length
    this.#host.transcript.notice(
      `${n === 1 ? 'A prompt' : `${n} prompts`} queued for the last session ${n === 1 ? 'is' : 'are'} back in the composer.`,
      'warning'
    )
    this.#host.changed()
  }

  /**
   * The startup image goes to the startup query at the queue's head, into its images in place;
   * false when nothing is held.
   */
  attachToHead(image: Image): boolean {
    const head = this.#held[0]?.prompt
    head?.images.push(image)

    return Boolean(head)
  }

  /** Prompts waiting behind the turn: this pane's own queue, then the shared gateway's. */
  count(): number {
    return this.#held.length + this.server.queued().length
  }

  /** The dock's queued rows, in count()'s order, with what each one's Edit and Steer can do. */
  rows(): QueuedRow[] {
    const steer = this.#host.busy()

    return [
      ...this.#held.map(({ prompt: p }): QueuedRow => ({ kind: 'local', steer, text: userText(shownText(p), p.images) })),
      ...this.server.queued().map((q): QueuedRow => {
        switch (q.kind) {
          case 'theirs':
            return { kind: 'foreign', note: q.row.status === 'unknown' ? 'unknown' : 'elsewhere', text: internalNotice(q.text) ?? q.text }

          // Withdrawing it needs the gateway's id for it: until prompt.submit answers it is on its way.
          case 'sending':
            return { kind: 'sending', text: q.text }

          case 'mine':
            return { kind: 'mine', steer: steer && !q.own.item.prompt.images.length, text: q.text }
        }
      })
    ]
  }

  /**
   * Admits `prompt` into session `sid`'s FIFO now (Ink's busy-time admission): crash-durable, and in
   * every viewer's queue. Its bubble waits until the gateway starts it; a refusal puts it back in
   * the composer. `sent`: what to send instead of expanding the prompt again (a re-queued steer).
   */
  async admit(sid: LiveSessionId, prompt: Prompt, sent?: string) {
    const host = this.#host
    // Every caller passes the shown session's id: the ticket guards the awaits below.
    const ticket = host.ticket()
    const ready = sent === undefined ? await host.expanded(sid, prompt) : { images: prompt.images, text: sent }

    if (!ready || !ticket.isCurrent()) {
      return
    }

    const own: OwnAdmission<Admitted> = {
      admission: { kind: 'submitting' },
      display: userText(shownText(prompt), prompt.images),
      inputId: newInputId(),
      item: { prompt, sent: ready.text }
    }
    const attachments = ready.images.map(({ mime, path }) => ({ mime, path }))
    this.server.admit(own)
    host.changed()

    try {
      const r = await rpc(host.gw, 'prompt.submit', {
        queued: true,
        session_id: sid,
        submission_id: own.inputId,
        text: ready.text || (attachments.length ? IMAGE_ONLY_PROMPT : ''),
        ...(attachments.length ? { attachments } : {})
      })
      // Only the shared gateway admits into a queue; its receipt names the admission.
      const id = admissionOf(r)

      if (id !== undefined) {
        this.server.admitted(own, id)
      }
    } catch (error) {
      // Back to the composer only while it was still being submitted: one the FIFO listed meanwhile
      // waits there still (a late timeout; its row stays this pane's), one it started runs as its
      // own turn, and one withdrawn left the queue on purpose.
      if (own.admission.kind === 'submitting') {
        this.server.drop(own)

        if (ticket.isCurrent()) {
          host.transcript.notice(`Not queued: ${errorText(error)}. Your message is back in the composer.`, 'error')
          host.restore(prompt)
        }
      }
    }

    host.changed()
  }

  /** Alt+Up / a queued row's Edit: queued prompt `index` (the oldest by default) back into the composer. */
  dequeue(index = 0) {
    const host = this.#host

    if (index < this.#held.length) {
      const [next] = this.#held.splice(index, 1)

      if (next) {
        host.restore(next.prompt)
        host.changed()
      }

      return
    }

    const ticket = host.ticket()
    const { sid } = ticket
    const q = this.#mine(index)

    if (!sid || !q) {
      return
    }

    void this.#withdraw(sid, q).then(out => {
      if (out && ticket.isCurrent()) {
        host.restore(q.own.item.prompt)
      }

      host.changed()
    })
  }

  /** Alt+Enter / a queued row's Steer: injects queued prompt `index` into the running turn instead of waiting for it to end. */
  steer(index: number) {
    const host = this.#host
    const ticket = host.ticket()
    const { sid } = ticket

    if (!host.busy() || !sid) {
      return
    }

    if (index >= this.#held.length) {
      return void this.#steerServerQueued(ticket, sid, index)
    }

    const item = this.#held[index]

    if (!item) {
      return
    }

    const { prompt } = item

    // A steer is text only: a prompt with images waits for its own turn.
    if (prompt.images.length) {
      host.transcript.notice('A queued prompt with images cannot steer the turn. It stays queued.', 'warning')

      return host.changed()
    }

    const { text } = prompt
    // The prompts ahead of it: a steer that fails puts it back behind those still held.
    const ahead = this.#held.slice(0, index)
    this.#held.splice(index, 1)
    host.changed()
    void steerTurn(host.gw, sid, text).then(r => {
      if (!ticket.isCurrent()) {
        // The view left the session: the transcript is another's, and so would the drain be.
        if (!r.ok) {
          host.restore(prompt)
          host.transcript.notice('The steer did not land before the session changed. It is back in the composer.', 'warning')
        }

        return host.changed()
      }

      if (r.ok) {
        host.transcript.steer(text)
      } else {
        // Back where it was: after the last prompt that was ahead of it and is still held (the
        // drain or an Edit may have taken some meanwhile), else at the head.
        const at = Math.max(0, ...ahead.map(h => this.#held.indexOf(h) + 1))
        this.#held.splice(at, 0, item)
        host.transcript.notice(
          r.error
            ? `Steer failed: ${r.error}. It stays queued.`
            : 'The turn ended before the steer landed. It will send as the next prompt.',
          'warning'
        )
        this.drain()
      }

      host.changed()
    })
  }

  /** Sends the oldest held prompt once the session is adopted and idle (no turn, switch or startup image pending). */
  drain() {
    if (!this.#host.canDrain()) {
      return
    }

    const next = this.#held.shift()

    if (next) {
      this.#host.send(next.prompt)
    }
  }

  /** The shared gateway's queued row at dock index `index`, if this pane can act on it. */
  #mine(index: number): Mine | undefined {
    const q = this.server.queued()[index - this.#held.length]

    return q?.kind === 'mine' ? q : undefined
  }

  /**
   * Takes this pane's admission out of the gateway's queue (prompt.cancel); true once withdrawn,
   * false when it started meanwhile (it runs as its own turn) or the gateway refused.
   */
  async #withdraw(sid: LiveSessionId, q: Mine): Promise<boolean> {
    // Its `cancelled` completion can come before the reply.
    this.server.withdrawn(q.id)

    try {
      const r = await rpc(this.#host.gw, 'prompt.cancel', { admission_id: q.id, session_id: sid })

      if (r?.status !== 'terminal') {
        return false
      }
    } catch (error) {
      this.#host.transcript.notice(`Could not take the prompt out of the queue: ${errorText(error)}`, 'error')
      this.#host.changed()

      return false
    }

    this.server.withdrew(q.own)

    return true
  }

  /**
   * A Steer on a row in the gateway's queue: withdrawn from it, then steered into the turn; a steer
   * that does not land goes back into the queue, at its end.
   */
  async #steerServerQueued(ticket: SessionTicket, sid: LiveSessionId, index: number) {
    const host = this.#host
    const q = this.#mine(index)

    if (!q) {
      return
    }

    const { prompt, sent } = q.own.item

    if (prompt.images.length) {
      host.transcript.notice('A queued prompt with images cannot steer the turn. It stays queued.', 'warning')

      return host.changed()
    }

    if (!(await this.#withdraw(sid, q)) || !ticket.isCurrent()) {
      return
    }

    const r = await steerTurn(host.gw, sid, sent)

    if (!ticket.isCurrent()) {
      return
    }

    if (r.ok) {
      host.transcript.steer(shownText(prompt))
    } else {
      host.transcript.notice(
        r.error ? `Steer failed: ${r.error}. Queued again, at the end.` : 'The turn ended before the steer landed. Queued again.',
        'warning'
      )
      void this.admit(sid, prompt, sent)
    }

    host.changed()
  }
}
