// Server requests (the gateway asking this pane a question) as the contract names them: the
// method says which params come (`ServerRequestMap`). The values are what the gateway sent,
// unread: each field the contract names is there to read, typed unknown, because a gateway of
// another version may send another shape. The readers (prompts/parse.ts) fall back where the
// sheets always fell back.

import type { ServerRequestMap, ServerRequestMethod } from '@hermes/shared/gateway-events'
import { SERVER_REQUEST_METHODS } from '@hermes/shared/gateway-events'
import type { ServerRequest } from '@hermes/shared/json-rpc-channel'

/** The fields of `P`, each one there to read and none trusted yet. */
export type Unread<P> = { readonly [K in keyof P]?: unknown }

/** A server request of method `M`, its params unread. */
export type RequestOf<M extends ServerRequestMethod> = Omit<ServerRequest, 'method' | 'params'> & {
  method: M
  params: Unread<ServerRequestMap[M]['params']>
}

/** One server request of any method the contract names: narrow it on `method`. */
export type AnyServerRequest = { [M in ServerRequestMethod]: RequestOf<M> }[ServerRequestMethod]

const KNOWN: ReadonlySet<string> = new Set(SERVER_REQUEST_METHODS)

/** `req` with its method's params, or undefined for a method the contract does not name. */
export function serverRequest(req: ServerRequest): AnyServerRequest | undefined {
  // boundary: the method names the params' fields; their values stay unknown until read.
  return KNOWN.has(req.method) ? (req as AnyServerRequest) : undefined
}
