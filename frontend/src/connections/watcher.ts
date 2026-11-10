// The connect cards in the transcript, kept current (live.ts reads the wire, cards.ts is the model).
// The gateway's `connection.request` draws a card on the call that opened it (or a resume's
// `pending_connection` does), its `connection.update` frames move its rows, and its buttons answer
// the gateway. The tool waits on the card and returns by itself, so nobody tells the agent anything.
// A read of `connectors.operation.status` each poll covers a frame the pane missed.

import type { ConnectionAnswer } from '@hermes/shared/gateway-events'

import { errorText, rpcErrorCode } from '../core/errors.js'
import { toolCallId } from '../core/ids.js'
import { Poller } from '../core/poller.js'
import type { ToolCall } from '../model.js'
import type { Transcript } from '../transcript/store.js'
import { record } from '../wire/json.js'
import { type Requester, rpc } from '../wire/rpc.js'

import { cardRef, CONNECT_TOOL, CONTINUE, type ConnectTarget, type LiveOp, POLL_MS, resultCard } from './cards.js'
import { answers, applyFrame, type LiveCard, liveCard, liveOpen, minutesLeft, opParams, respondParams, retryParams, verbOf } from './live.js'

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
  /** Opens `url` in the browser. */
  openUrl(url: string): void
}

/** Follows the open connect cards; one owner for the poll. */
export class ConnectWatcher {
  readonly #host: WatcherHost
  /** The poll: every POLL_MS while some card is watched. */
  readonly #poller: Poller = new Poller({ cadence: () => (this.#open ? POLL_MS : 'off'), run: async () => this.#tick() })
  /** Some card's operation is still open (the last poll found one not settled). */
  #open = false
  /** The minutes each open live card's hint last showed. */
  readonly #minutes = new WeakMap<ToolCall, number>()
  /** Calls whose result already had its say over a `stopped` card. */
  readonly #finals = new WeakSet<ToolCall>()

  constructor(host: WatcherHost) {
    this.#host = host
  }

  /**
   * Polls every open card now (a finished call or a reloaded transcript does not wait for the next
   * poll), then while some card is open: a settled card never moves again.
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

  /** A connect card's Continue: the tool returns now, its unresolved apps not connected. */
  continue(ref: string) {
    const call = this.#call(ref)

    if (call && !call.connect?.settled) {
      this.#answer(call, CONTINUE, answers.continue())
    }
  }

  /**
   * A typed message while a live card waits ends the wait, as the desktop's composer does: else
   * the message waits behind the blocked tool until its deadline.
   */
  yieldOpen() {
    for (const call of this.#host.transcript.calls(CONNECT_TOOL)) {
      if (liveOpen(call.connect)) {
        this.#answer(call, CONTINUE, answers.continue())
      }
    }
  }

  /** A connect card's Authorize: the app's link in the browser, and its row waits on the browser now. */
  open(ref: string, name: string) {
    const call = this.#call(ref)
    const card = call?.connect
    const target = card?.targets.find(t => t.name === name)

    if (!call || !card?.op || !target?.url || card.settled) {
      return
    }

    this.#host.openUrl(target.url)
    this.#host.transcript.mutateCall(call, () => (card.opened = [...new Set([...card.opened, name])]))
    this.#host.changed()
    // The gateway reads the accounts now rather than at its next tick. It only shortens the wait:
    // the operation may have settled meanwhile.
    void rpc(this.#host.gw, 'connectors.operation.wake', opParams(card.op)).catch(() => undefined)
  }

  /** A live card's Skip on app `name`. */
  skip(ref: string, name: string) {
    this.#row(ref, name, (call, target) => this.#answer(call, `skip:${name}`, answers.skip(target)))
  }

  /** A live card's Connect on MCP app `name`: the gateway starts its install. */
  approve(ref: string, name: string) {
    this.#row(ref, name, (call, target) => verbOf(target) === 'approve' && this.#answer(call, `approve:${name}`, answers.approve(target)))
  }

  /** A live card's Try again on app `name`, whose link failed or expired: the gateway mints a new one. */
  retry(ref: string, name: string) {
    this.#row(ref, name, (call, target, op) => {
      if (verbOf(target) === 'retry') {
        // The new link is not opened yet: the row waits on the user again, not on the browser.
        this.#host.transcript.mutateCall(call, c => c.connect && (c.connect = { ...c.connect, opened: c.connect.opened.filter(n => n !== name) }))
        this.#send(call, `retry:${name}`, () => rpc(this.#host.gw, 'connectors.connect', retryParams(op, name)), `Could not start ${target.title} again`, reply =>
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

    for (const call of this.#host.transcript.calls(CONNECT_TOOL)) {
      open = this.#tickLive(call) || open
    }

    this.#open = open
  }

  /**
   * One live card's poll: settled by its call's result once the tool returned (the settling frame
   * may not have come), else its status read again. True while it is open.
   */
  #tickLive(call: ToolCall): boolean {
    const card = call.connect

    if (card?.op && card.settled === 'stopped' && call.result !== undefined) {
      this.#final(call, card.op)

      return false
    }

    if (!card?.op || card.settled) {
      return false
    }

    // The hint counts minutes down; an unchanged card is not redrawn, so the watcher redraws it.
    const minutes = minutesLeft(card.op, Date.now())

    if (this.#minutes.get(call) !== minutes) {
      this.#minutes.set(call, minutes)
      this.#host.transcript.mutateCall(call, () => undefined)
      this.#host.changed()
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
    const named = callId ? transcript.call(toolCallId(callId)) : undefined
    // A finished call of the same id (a model reusing ids across turns) is not this operation's.
    const stale = named !== undefined && named.outcome.kind !== 'running'
    let call = stale ? undefined : (named ?? transcript.lastCall(c => c.name === CONNECT_TOOL && c.outcome.kind === 'running' && !c.connect))

    if (!call) {
      // Its tool.start has not come, or a resume's history lacks the running call.
      const id = callId && !stale ? callId : `connect-${card.op.id}`

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
      const params = respondParams({ deadlineAt: 0, id: op, seq: 0, session: sid }, answers.continue())

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

  /**
   * The tool's result over a card the pane settled as `stopped` by itself (its status read found no
   * operation: the gateway drops it just before the tool returns). The result is the gateway's own
   * account of how the rows ended, so it replaces the pane's guess, once.
   */
  #final(call: ToolCall, op: LiveOp) {
    const card = call.connect
    const final = this.#finals.has(call) ? undefined : resultCard(call)

    this.#finals.add(call)

    if (card && final && record(call.result)?.['op_id'] === op.id) {
      const before = new Map(card.targets.map(t => [t.name, t]))
      const targets = final.targets.map(t => ({ ...t, url: t.url ?? before.get(t.name)?.url }))

      this.#host.transcript.mutateCall(call, c => (c.connect = { ...card, settled: final.settled, targets }))
      this.#host.changed()
    }
  }

  /** Settles `call`'s live card by the pane's own word (`stopped`): nothing moves it any more until the tool's result (#final). */
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

  /** `connection.respond` for `call`'s card (`row`: `<verb>:<app>`, or CONTINUE); the gateway's frames move the rows. */
  #answer(call: ToolCall, row: string, answer: ConnectionAnswer) {
    const op = call.connect?.op

    if (op) {
      this.#send(call, row, () => rpc(this.#host.gw, 'connection.respond', respondParams(op, answer)), 'Could not answer the connection card')
    }
  }

  /**
   * Starts one answer of `call`'s card, unless that row's last one is still in flight; a refusal is a
   * notice. The row is on the card's `sending` meanwhile, so its button says so.
   */
  #send<T>(call: ToolCall, row: string, start: () => Promise<T>, failure: string, then?: (reply: T) => void) {
    const app = row.slice(row.indexOf(':') + 1)

    // One answer per row at a time (a Skip waits for a Try again of the same app), and one Continue.
    if (!call.connect || call.connect.sending?.some(r => r === row || (row !== CONTINUE && r.endsWith(`:${app}`)))) {
      return
    }

    this.#sending(call, row, true)
    void start()
      .then(
        reply => then?.(reply),
        (error: unknown) => this.#failed(failure, error)
      )
      .finally(() => this.#sending(call, row, false))
  }

  /** Puts row `row` of `call`'s card on its `sending` list, or takes it off. */
  #sending(call: ToolCall, row: string, on: boolean) {
    this.#host.transcript.mutateCall(call, c => {
      const card = c.connect

      if (card) {
        const rest = (card.sending ?? []).filter(r => r !== row)

        c.connect = { ...card, sending: on ? [...rest, row] : rest.length ? rest : undefined }
      }
    })
    this.#host.changed()
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

  /** The connect card `ref` names (its operation, or its call id when it has none). */
  #call(ref: string) {
    return this.#host.transcript.calls(CONNECT_TOOL).findLast(c => cardRef(c) === ref)
  }
}
