// Typed gateway requests. A caller speaks the classic contract (`RpcMethods`); on a shared
// gateway the client's canonical adapter (ui-tui/src/canonicalGateway.ts) rewrites the params
// and reshapes some results, so a result is the classic shape or the shared gateway's, adapted.
// `rpc()` holds the one trusted cast; `rpcParsed()` checks shapes that differ between versions.

import type {
  AdmissionStatus,
  CanonicalRpcMethods,
  CanonicalSnapshot,
  RpcMethods,
  TranscriptMessage
} from '@hermes/shared/gateway-events'
import type { GatewayClient } from '@tui/gatewayClient.js'
import type { SessionInfo } from '@tui/types.js'
import type { ZodMiniType } from 'zod/mini'

import {
  type AdmissionId,
  admissionId,
  liveSessionId,
  type SessionRef,
  storedSessionId,
  subscriptionId,
  type SubscriptionId
} from '../core/ids.js'

type Classic = RpcMethods
type Canonical = CanonicalRpcMethods

/** A gateway method: one of the classic contract, or one only the shared gateway serves. */
export type Method = keyof Classic | keyof Canonical

/**
 * What a caller sends. A method both contracts name takes either one's params: the pane sends a
 * shared gateway's fields (`submission_id`, `execution_generation`, `attachments`) on the classic
 * method, and canonicalRequest renames them.
 */
export type Params<M extends Method> =
  | (M extends keyof Classic ? Classic[M]['params'] : never)
  | (M extends keyof Canonical ? Canonical[M]['params'] : never)

/**
 * A session snapshot as canonicalResult hands it on (session.create, session.resume and
 * session.activate on a shared gateway): `messages` are the display rows, `stored_messages` the
 * raw ones, and `info` carries the authority's ids, generation and FIFO.
 */
export interface AdaptedSnapshot extends Omit<CanonicalSnapshot, 'display_messages' | 'info'> {
  stored_messages: TranscriptMessage[]
  info: SessionInfo & {
    stored_session_id: string
    execution_epoch: string
    execution_generation: number
    running: boolean
  }
}

/** A submission's receipt as canonicalResult hands it on: the input id it was sent under, and where it went. */
export interface AdaptedSubmit extends AdmissionStatus {
  input_id?: string
  target_profile_home: string
  target_session_id: string
}

/** The results canonicalResult reshapes. session.steer and session.redirect answer with no `ref`, which it passes on as is. */
interface Adapted {
  'prompt.submit': AdaptedSubmit
  'session.activate': AdaptedSnapshot
  'session.create': AdaptedSnapshot
  'session.resume': AdaptedSnapshot
}

type ClassicResult<M extends Method> = M extends keyof Classic ? Classic[M]['result'] : never

/** What a method answers: the classic result, or the shared gateway's (as adapted, where the adapter reshapes it). */
export type ResultOf<M extends Method> = M extends keyof Adapted
  ? ClassicResult<M> | Adapted[M]
  : ClassicResult<M> | (M extends keyof Canonical ? Canonical[M]['result'] : never)

/** The client's request, the one part of GatewayClient these helpers use. */
export type Requester = Pick<GatewayClient, 'request'>

/** Sends `method` with `params` as they are, and trusts the answer as the contract's. */
export function rpc<M extends Method>(gw: Requester, method: M, params: Params<M>): Promise<ResultOf<M>> {
  // boundary: the gateway's answer, typed by the generated contract (upstream tests it against the Python).
  return gw.request<ResultOf<M>>(method, params as Record<string, unknown>)
}

/** Sends `method` and parses the answer with `schema`; a shape it refuses rejects, as a failed request does. */
export async function rpcParsed<M extends Method, T>(gw: Requester, method: M, params: Params<M>, schema: ZodMiniType<T>): Promise<T> {
  return schema.parse(await gw.request<unknown>(method, params as Record<string, unknown>))
}

/** The fields of a session.create or session.resume result, from either gateway, that name ids. */
export interface SnapshotIdFields {
  session_id: string
  stored_session_id?: string | null
  subscription_id?: string | null
  info?: { stored_session_id?: string | null } | null
}

/** What a session.create or session.resume result names: the session's ids, and this view's subscription to it. */
export interface SnapshotIds {
  ref: SessionRef
  /** The shared gateway's subscription for this view; a private gateway has none. */
  subscription: SubscriptionId | undefined
}

/**
 * The ids `r` names. The stored id is the info's (the shared gateway's), else the result's own
 * (a private gateway's); an empty one is none, and stays null so a reader that needs a stored id
 * can tell.
 */
export function snapshotIds(r: SnapshotIdFields): SnapshotIds {
  const stored = r.info?.stored_session_id || r.stored_session_id

  return {
    ref: { live: liveSessionId(r.session_id), stored: stored ? storedSessionId(stored) : null },
    subscription: r.subscription_id ? subscriptionId(r.subscription_id) : undefined
  }
}

/** The admission a prompt.submit receipt names; only the shared gateway admits into a queue. */
export function admissionOf(r: ResultOf<'prompt.submit'> | null | undefined): AdmissionId | undefined {
  return r && 'admission_id' in r ? admissionId(r.admission_id) : undefined
}
