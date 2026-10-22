// The connect cards in the transcript, kept current, one owner for both wires (cards.ts):
//
// - a live card (live.ts): the gateway's `connection.request` draws it on the call that opened it
//   (or a resume's `pending_connection` does), its `connection.update` frames move its rows, and
//   its buttons answer the gateway. The tool waits on the card and returns by itself, so nobody
//   tells the agent anything. A read of `connectors.operation.status` each poll covers a frame the
//   pane missed.
// - a card file (an older gateway's no-card result): the poll follows the file the plugin's watcher
//   writes, and the agent is told once every app of the card is connected, or on Continue.
//
// The card files are cards.ts's; this module only reads and claims them.

import type { ConnectionAnswer } from '@hermes/shared/gateway-events'

import { errorText, rpcErrorCode } from '../core/errors.js'
import { toolCallId } from '../core/ids.js'
import { Poller } from '../core/poller.js'
import type { ToolCall } from '../model.js'
import type { Transcript } from '../transcript/store.js'
import { record } from '../wire/json.js'
import { type Requester, rpc } from '../wire/rpc.js'

import {
  allConnected,
  cardRef,
  CONNECT_TOOL,
  type ConnectTarget,
  connectedMessage,
  continueMessage,
  type LiveOp,
  loadConnect,
  mayTell,
  POLL_MS,
  waiting
} from './cards.js'
import { answers, applyFrame, type LiveCard, liveCard, liveOpen, opParams, respondParams, retryParams, verbOf } from './live.js'

/**
 * How long a connect call that drew no card (a status read, a call with nothing to authorize) is
 * not read again. Its card may still land (a write the pane read half of): it is read once more after.
 */
export const NO_CARD_MS = 30_000

/** The gateway's refusal for an operation it no longer holds (tui_gateway/connector_refusals.py UNKNOWN_OPERATION). */
const UNKNOWN_OPERATION = 4004

/** What the connect watcher reaches of the app. */
export interface WatcherHost {
  readonly transcript: Pick<Transcript, 'call' | 'calls' | 'lastCall' | 'mutateCall' | 'notice' | 'toolStart'>
  /** The gateway a live card answers. */
  readonly gw: Requester
  /** The shown session's runtime id: a live card's owner when its event names none. */
  sid(): string | null
  /** Asks for a render. */
  changed(): void
  /** Sends `text` to the agent as a message the app writes: it waits behind a running turn. */
  tell(text: string): void
  /** Opens `url` in the browser. */
  openUrl(url: string): void
}

/** Follows the open connect cards; one owner for the poll. */
export class ConnectWatcher {
  readonly #host: WatcherHost
  /** Where the card files are; unset: the plugin's data folder, read at each poll. */
  readonly #dir: string | undefined
  /** The poll: every POLL_MS while some card is watched. */
  readonly #poller: Poller = new Poller({ cadence: () => (this.#open ? POLL_MS : 'off'), run: async () => this.#tick() })
  /** Some card's apps still move (the last read found one watched and not settled). */
  #open = false
  /** Connect cards (by file) this pane saw with an app still waiting. */
  readonly #seen = new Set<string>()
  /** Connect calls that drew no card, and when: not read again for NO_CARD_MS. */
  readonly #noCard = new WeakMap<object, number>()
  /** A live card's answers in flight (`<op>:<app>`, `<op>:` for Continue): a second press waits for the first. */
  readonly #sending = new Set<string>()

  /** `dir`: the plugin's data folder the card files are under (tests point it at their own). */
  constructor(host: WatcherHost, { dir }: { dir?: string } = {}) {
    this.#host = host
    this.#dir = dir
  }

  /**
   * Reads every connect card now (a new call or a reloaded transcript does not wait for the next
   * poll), then polls while some card is watched: a settled card never moves again.
   */
  watch() {
    this.#poller.poke()
  }

  /** `connection.request`: the gateway opened an operation for session `session`; its card goes on the call that opened it. */
  request(payload: unknown, session: string | undefined) {
    const drawn = this.#byOp(record(payload)?.['op_id'])

    // Its card is up already (a request held across a switch, then a resume's): a frame of it.
    if (drawn) {
      this.#apply(drawn, payload)

      return
    }

    const sid = session || this.#host.sid()
    const live = sid ? liveCard(payload, sid) : undefined

    if (live) {
      this.#draw(live)
    } else {
      this.#undrawable(payload, sid)
    }
  }

  /** A resume's `pending_connection`: the operation still open on the session, drawn as its request was. */
  restore(payload: unknown, session: string) {
    if (payload) {
      this.request(payload, session)
    }
  }

  /** `connection.update`: a row moved or the operation settled. */
  update(payload: unknown, session: string | undefined) {
    const op = record(payload)?.['op_id']
    const call = this.#byOp(op)

    if (call) {
      this.#apply(call, payload)

      return
    }

    // An operation whose request this pane missed (it attached mid-wait): the frame draws it.
    const sid = session || this.#host.sid()
    const live = sid ? liveCard(payload, sid) : undefined

    if (live && !live.card.settled) {
      this.#draw(live)
    }
  }

  /** A connect card's Continue: a live card's tool returns now; a card file tells the agent which apps the user authorized. */
  continue(ref: string) {
    const call = this.#call(ref)
    const card = call?.connect

    if (!call || !card || card.told || card.settled) {
      return
    }

    if (card.op) {
      this.#answer(call, '', answers.continue())

      return
    }

    // As on the desktop, Continue settles the card: an app still waiting did not connect.
    this.#host.transcript.mutateCall(call, () => {
      card.told = true
      card.settled = 'continued'
    })

    // Another pane's message already told the agent.
    if (mayTell(card, this.#dir)) {
      this.#host.tell(continueMessage(card.targets))
    }

    this.#host.changed()
  }

  /**
   * A typed message while a live card waits ends the wait, as the desktop's composer does: else
   * the message waits behind the blocked tool until its deadline.
   */
  yieldOpen() {
    for (const call of this.#host.transcript.calls(CONNECT_TOOL)) {
      if (liveOpen(call.connect)) {
        this.#answer(call, '', answers.continue())
      }
    }
  }

  /** A connect card's Authorize: the app's link in the browser, and its row waits on the browser now. */
  open(ref: string, name: string) {
    const call = this.#call(ref)
    const card = call?.connect
    const target = card?.targets.find(t => t.name === name)

    if (!call || !card || !target?.url || card.settled) {
      return
    }

    this.#host.openUrl(target.url)
    this.#host.transcript.mutateCall(call, () => (card.opened = [...new Set([...card.opened, name])]))
    this.#host.changed()

    // The gateway reads the accounts now rather than at its next tick. It only shortens the wait:
    // the operation may have settled meanwhile.
    if (card.op) {
      void rpc(this.#host.gw, 'connectors.operation.wake', opParams(card.op)).catch(() => undefined)
    }
  }

  /** A live card's Skip on app `name`. */
  skip(ref: string, name: string) {
    this.#row(ref, name, (call, target) => this.#answer(call, name, answers.skip(target)))
  }

  /** A live card's Connect on MCP app `name`: the gateway starts its install. */
  approve(ref: string, name: string) {
    this.#row(ref, name, (call, target) => verbOf(target) === 'approve' && this.#answer(call, name, answers.approve(target)))
  }

  /** A live card's Try again on app `name`, whose link failed or expired: the gateway mints a new one. */
  retry(ref: string, name: string) {
    this.#row(ref, name, (call, target, op) => {
      if (verbOf(target) === 'retry') {
        this.#send(call, name, () => rpc(this.#host.gw, 'connectors.connect', retryParams(op, name)), `Could not start ${target.title} again`, reply =>
          this.#apply(call, reply)
        )
      }
    })
  }

  /** Stops the poll for good. */
  dispose() {
    this.#poller.dispose()
  }

  #tick() {
    let open = false
    const now = Date.now()

    for (const call of this.#host.transcript.calls(CONNECT_TOOL)) {
      if (call.connect?.op) {
        open = this.#tickLive(call) || open
        continue
      }

      const missed = this.#noCard.get(call)

      // A running call has no card yet; by its call id alone it would take an earlier call's.
      if (call.connect?.settled || call.outcome.kind === 'running' || (missed !== undefined && now - missed < NO_CARD_MS)) {
        continue
      }

      const next = loadConnect(call, this.#dir)

      if (!next) {
        this.#noCard.set(call, now)
        continue
      }

      this.#noCard.delete(call)

      if (JSON.stringify(next) !== JSON.stringify(call.connect)) {
        this.#host.transcript.mutateCall(call, c => (c.connect = next))
        this.#host.changed()
      }

      const seen = next.key ?? call.id

      if (next.targets.some(waiting) && !next.settled) {
        this.#seen.add(seen)
      }

      // Only a card this pane saw waiting: a resumed session's long-settled card stays quiet. Only
      // one pane tells: the claim is the card's.
      if (!next.told && this.#seen.has(seen) && allConnected(next) && mayTell(next, this.#dir)) {
        this.#host.transcript.mutateCall(call, () => (next.told = true))
        this.#host.tell(connectedMessage(next.targets))
        this.#host.changed()
      } else if (next.key && !next.settled) {
        open = true
      }
    }

    this.#open = open
  }

  /**
   * One live card's poll: settled by its call's result once the tool returned (the settling frame
   * may not have come), else its status read again. True while it is open.
   */
  #tickLive(call: ToolCall): boolean {
    const card = call.connect

    if (!card?.op || card.settled) {
      return false
    }

    if (call.result !== undefined) {
      this.#apply(call, call.result)

      // A result that is no frame of the operation (the tool failed): nothing waits on the card now.
      if (!call.connect?.settled) {
        this.#settle(call, 'stopped')
      }

      return false
    }

    const op = card.op

    rpc(this.#host.gw, 'connectors.operation.status', opParams(op)).then(
      frame => this.#apply(call, frame),
      (error: unknown) => {
        // The gateway holds no such operation: it settled, and the frame that said so never came.
        if (rpcErrorCode(error) === UNKNOWN_OPERATION && call.connect?.op?.id === op.id) {
          this.#settle(call, 'stopped')
        }
      }
    )

    return true
  }

  /** Draws `live` on its call: the one its tool call id names, else a row for it, as the desktop upserts one. */
  #draw({ callId, card }: LiveCard) {
    const { transcript } = this.#host
    let call = callId ? transcript.call(toolCallId(callId)) : transcript.lastCall(c => c.name === CONNECT_TOOL && c.outcome.kind === 'running' && !c.connect)

    if (!call) {
      // Its tool.start has not come, or a resume's history lacks the running call.
      const id = callId ?? `connect-${card.op.id}`

      transcript.toolStart({ args: { action: 'connect', connectors: card.targets.map(t => t.name) }, name: CONNECT_TOOL, tool_id: id })
      call = transcript.call(toolCallId(id))
    }

    if (!call) {
      this.#undrawable(undefined, card.op.session)

      return
    }

    transcript.mutateCall(call, c => (c.connect = card))
    this.#open = true
    this.watch()
    this.#host.changed()
  }

  /** A request the pane cannot draw: it says so, and answers Continue so the tool does not wait out its deadline. */
  #undrawable(payload: unknown, sid: string | null | undefined) {
    const op = record(payload)?.['op_id']
    const answered = typeof op === 'string' && op && sid

    this.#host.transcript.notice(
      answered
        ? 'Hermes asked for a connection card this pane cannot draw, so the pane answered Continue: the tool carries on without it. Connect apps in Hermes Desktop or the Nous Portal.'
        : 'Hermes asked for a connection card this pane cannot read. Its tool waits until the card times out; press Esc twice to stop it.',
      'warning'
    )
    this.#host.changed()

    if (answered) {
      const params = respondParams({ deadlineAt: 0, id: op, seq: 0, session: sid, timeoutSeconds: 0 }, answers.continue())

      void rpc(this.#host.gw, 'connection.respond', params).catch((error: unknown) => this.#failed('Could not answer the connection card', error))
    }
  }

  /** Applies a frame of its operation to `call`'s card, when it moves something. */
  #apply(call: ToolCall, frame: unknown) {
    const card = call.connect
    const next = card && applyFrame(card, frame)

    if (next) {
      this.#host.transcript.mutateCall(call, c => (c.connect = next))
      this.#host.changed()
    }
  }

  /** Settles `call`'s live card by the pane's own word (`stopped`): nothing moves it any more. */
  #settle(call: ToolCall, reason: 'stopped') {
    const card = call.connect

    if (card?.op && !card.settled) {
      this.#host.transcript.mutateCall(call, c => (c.connect = { ...card, settled: reason }))
      this.#host.changed()
    }
  }

  /** Runs `act` on row `name` of the open live card `ref`. */
  #row(ref: string, name: string, act: (call: ToolCall, target: ConnectTarget, op: LiveOp) => unknown) {
    const call = this.#call(ref)
    const card = call?.connect
    const target = card?.targets.find(t => t.name === name)

    if (call && card?.op && target && !card.settled) {
      act(call, target, card.op)
    }
  }

  /** `connection.respond` for `call`'s card (`row`: the app it answers, '' for Continue); the gateway's frames move the rows. */
  #answer(call: ToolCall, row: string, answer: ConnectionAnswer) {
    const op = call.connect?.op

    if (op) {
      this.#send(call, row, () => rpc(this.#host.gw, 'connection.respond', respondParams(op, answer)), 'Could not answer the connection card')
    }
  }

  /** Starts one answer of `call`'s card, unless that row's last one is still in flight; a refusal is a notice. */
  #send<T>(call: ToolCall, row: string, start: () => Promise<T>, failure: string, then?: (reply: T) => void) {
    const key = `${call.connect?.op?.id ?? ''}:${row}`

    if (this.#sending.has(key)) {
      return
    }

    this.#sending.add(key)
    void start()
      .then(
        reply => then?.(reply),
        (error: unknown) => this.#failed(failure, error)
      )
      .finally(() => this.#sending.delete(key))
  }

  /** An answer the gateway refused or never got: a notice, and the card stays as the gateway left it. */
  #failed(what: string, error: unknown) {
    this.#host.transcript.notice(`${what}: ${errorText(error)}`, 'warning')
    this.#host.changed()
  }

  /** The call whose live card is operation `op`. */
  #byOp(op: unknown): ToolCall | undefined {
    return typeof op === 'string' && op ? this.#host.transcript.calls(CONNECT_TOOL).findLast(c => c.connect?.op?.id === op) : undefined
  }

  /** The connect card `ref` names (its operation, its file, or its call id when it has neither). */
  #call(ref: string) {
    return this.#host.transcript.calls(CONNECT_TOOL).findLast(c => cardRef(c) === ref)
  }
}
