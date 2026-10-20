// The gateway's three streams, followed from run() on: each event goes to the development tap
// and through its handler (dispatch.ts), rendering when the handler says so; each server request
// goes to the tap and to its prompt sheet; and each exit of the gateway process ends what the
// lost session held, once per outage.

import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import type { GatewayClient } from '@tui/gatewayClient.js'
import type { AnyGatewayEvent } from '@tui/gatewayTypes.js'

import type { Reconnect } from '../chrome/reconnect.js'
import type { PromptSheets } from '../prompts/sheets.js'
import type { SessionLifecycle } from '../session/lifecycle.js'
import type { Transcript } from '../transcript/store.js'
import type { Activity } from '../turn/activity.js'

import { dispatcher, type EventCx } from './dispatch.js'
import { eventLog } from './eventLog.js'

/** What following the gateway reaches: the handlers' context, and what an exit ends. */
export type FollowCx = EventCx & {
  readonly activity: Pick<Activity, 'endBusy'>
  readonly reconnect: Pick<Reconnect, 'lost'>
  readonly life: Pick<SessionLifecycle, 'follow' | 'lost'>
  readonly sheets: Pick<PromptSheets, 'dropAll'>
  readonly transcript: Pick<Transcript, 'interrupt'>
  /** The development tap's file (HERMES_TERN_EVENT_LOG); empty for none. */
  readonly eventLog: string
}

/** Follows `gw`'s events, requests and exits, then lets the events it held come. */
export function followGateway(gw: Pick<GatewayClient, 'attached' | 'drain' | 'on'>, cx: FollowCx) {
  const log = eventLog(cx.eventLog)
  const dispatch = dispatcher(cx, type => log.unknown(type))

  const deliver = (ev: AnyGatewayEvent) => {
    if (dispatch(ev) === 'render') {
      cx.changed()
    }
  }

  // An event held across a switch comes back through the dispatcher (the tap logged it once).
  cx.life.follow(deliver)
  gw.on('event', (ev: AnyGatewayEvent) => {
    log.event(ev)
    deliver(ev)
  })
  gw.on('request', (req: ServerRequest) => {
    log.request(req)
    cx.request(req)
  })
  gw.on('exit', (code: null | number) => {
    // Once per outage: each failed redial emits another exit. An attached gateway (and its turn) lives on.
    const lost = cx.reconnect.lost(gw.attached, code)

    if (lost) {
      cx.transcript.notice(lost.text, lost.tone)
    }

    // The runtime session died with the process: prompts queue until the next gateway.ready
    // reattaches, and nothing can answer the held requests now.
    cx.life.lost()
    cx.activity.endBusy()
    // Nothing can answer the sheets either; the reattach re-opens the questions still pending.
    cx.sheets.dropAll()
    cx.transcript.interrupt()
    cx.changed()
  })
  gw.drain()
}
