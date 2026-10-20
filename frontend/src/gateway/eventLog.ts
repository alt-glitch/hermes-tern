// The development tap (HERMES_TERN_EVENT_LOG, for the lab and the golden replays' fixtures): one
// JSON line per gateway event, as the event itself, and per server request, as
// `{"request": {id, method, params}}`. An event type the pane does not know adds one
// `{"unknown": type}` line the first time it comes. With no file named, it writes nothing.

import { appendFileSync } from 'node:fs'

import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import type { AnyGatewayEvent } from '@tui/gatewayTypes.js'

/** The tap: what it writes for each event, server request and unknown event type. */
export interface EventLog {
  event(ev: AnyGatewayEvent): void
  request(req: ServerRequest): void
  unknown(type: string): void
}

/** The tap writing to `path`; '' writes nothing. */
export function eventLog(path: string): EventLog {
  const write = (line: unknown) => {
    if (path) {
      appendFileSync(path, `${JSON.stringify(line)}\n`)
    }
  }

  return {
    event: ev => write(ev),
    request: req => write({ request: { id: req.id, method: req.method, params: req.params } }),
    unknown: type => write({ unknown: type })
  }
}
