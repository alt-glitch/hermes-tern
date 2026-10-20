// This pane's views of sessions on the gateway. On the shared gateway a view is a subscription:
// leaving a session detaches it, and the session keeps running for its other viewers; a private
// gateway closes the session instead. Switches that a later switch superseded may have attached a
// session nobody will show; they are released once the switches settle.

import type { GatewayClient } from '@tui/gatewayClient.js'

import type { DurableSessionId, LiveSessionId, SessionRef, SubscriptionId } from '../core/ids.js'
import { rpc, snapshotIds, type SnapshotIdFields } from '../wire/rpc.js'

/** Why this pane leaves a session: a switch away (`tui_close`) or the pane quitting (`tui_shutdown`). */
export type EndReason = 'tui_close' | 'tui_shutdown'

/** The gateway as the views use it. */
export type ViewsGateway = Pick<GatewayClient, 'isCanonical' | 'request'>

/** The subscriptions this pane holds, the detaches in flight, and what superseded switches attached. */
export class SessionViews {
  readonly #gw: ViewsGateway
  /** Shared-gateway subscriptions this view holds, by session id. */
  readonly #subscriptions = new Map<LiveSessionId, SubscriptionId>()
  /** What superseded switches attached; released once no switch is in flight (see `release`). */
  #stale: SnapshotIdFields[] = []
  /**
   * The last `session.detach` in flight per session: a resume of that id waits for it (they share a
   * subscription id). Set under the runtime id detached and read under the id a resume names: the
   * shared gateway, the one that detaches, answers with one id for both.
   */
  readonly #detaching = new Map<DurableSessionId, Promise<unknown>>()

  constructor(gw: ViewsGateway) {
    this.#gw = gw
  }

  /** Takes the ids of an adopted snapshot `r`, keeping its subscription (the shared gateway's). */
  adopt(r: SnapshotIdFields): SessionRef {
    const { ref, subscription } = snapshotIds(r)

    if (subscription) {
      this.#subscriptions.set(ref.live, subscription)
    }

    return ref
  }

  /** The detach of session `id` still in flight, if any. */
  detaching(id: DurableSessionId): Promise<unknown> | undefined {
    return this.#detaching.get(id)
  }

  /** A switch's result that a later switch superseded: nothing will show it. */
  superseded(r: SnapshotIdFields) {
    this.#stale.push(r)
  }

  /** Leaves every session this pane holds a subscription to. */
  leaveAll(endReason: EndReason): Promise<unknown> {
    return Promise.all([...this.#subscriptions.keys()].map(sid => this.leave(sid, endReason)))
  }

  /** Stops showing session `sid`: a shared-gateway view detaches (the session keeps running for its other viewers); a private gateway closes it. */
  async leave(sid: LiveSessionId, endReason: EndReason) {
    const subscription = this.#subscriptions.get(sid)

    if (!this.#gw.isCanonical) {
      await rpc(this.#gw, 'session.close', { session_id: sid }).catch(() => undefined)

      return
    }

    if (!subscription) {
      return
    }

    this.#subscriptions.delete(sid)
    await this.#detach(sid, subscription, endReason)
  }

  /**
   * Releases what superseded switches attached, once the adopted session (`shown`) is known. The
   * gateway gives this view one subscription per session, so a stale result for the shown session
   * is the live view's own and stays; others detach with no end reason (nobody chose to close them).
   */
  release(shown: LiveSessionId | null) {
    const stale = this.#stale
    this.#stale = []

    for (const r of stale) {
      const { ref, subscription } = snapshotIds(r)

      if (ref.live === shown || (subscription && this.#subscriptions.get(ref.live) === subscription)) {
        continue
      }

      if (!this.#gw.isCanonical) {
        void rpc(this.#gw, 'session.close', { session_id: ref.live }).catch(() => undefined)
      } else if (subscription) {
        void this.#detach(ref.live, subscription)
      }
    }
  }

  /** Sends `session.detach`, one at a time per session; `endReason` lets the owner end it once no viewer remains. */
  #detach(sid: LiveSessionId, subscription: SubscriptionId, endReason?: EndReason) {
    const send = () =>
      rpc(this.#gw, 'session.detach', {
        ...(endReason ? { end_reason: endReason } : {}),
        session_id: sid,
        subscription_id: subscription
      })
    const run = (this.#detaching.get(sid)?.then(send) ?? send()).catch(() => undefined)
    this.#detaching.set(sid, run)
    void run.then(() => {
      if (this.#detaching.get(sid) === run) {
        this.#detaching.delete(sid)
      }
    })

    return run
  }
}
