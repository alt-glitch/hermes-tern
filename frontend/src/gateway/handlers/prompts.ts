// The gateway's questions as events: the shared gateway's approval and clarify prompts, their
// settling (answered here or by another viewer), and a request the gateway withdrew.

import type { ServerRequest } from '@hermes/shared/json-rpc-channel'

import { sharedPromptId, sharedPromptRequest } from '../../hermes/sharedPrompts.js'
import { promptTimeoutNotice } from '../../overlays/prompts.js'
import type { PromptSheets } from '../../prompts/sheets.js'
import type { SessionLifecycle } from '../../session/lifecycle.js'
import type { Transcript } from '../../transcript.js'
import type { Requester } from '../../wire/rpc.js'
import type { EventOf, Handlers, Outcome } from '../dispatch.js'

/** What the prompts' events reach of the app. */
export interface PromptsCx {
  readonly gw: Requester
  readonly life: Pick<SessionLifecycle, 'unhold'>
  readonly sheets: Pick<PromptSheets, 'drop' | 'dropByApproval' | 'shows'>
  readonly transcript: Pick<Transcript, 'notice'>
  /** Shows a server request (its sheet), or holds it while a switch is in flight. */
  request(req: ServerRequest): void
  /** Asks for a render. */
  changed(): void
}

/** A shared prompt: the same sheet a server request opens, answered through approval.respond or clarify.respond. */
function asked(ev: EventOf<'approval.request' | 'clarify.request'>, cx: PromptsCx): Outcome {
  const req = sharedPromptRequest(ev, cx.gw, message => {
    cx.transcript.notice(message, 'warning')
    cx.changed()
  })

  if (req) {
    cx.request(req)
  }

  return 'render'
}

/** A shared prompt answered here or by another viewer: the sheet goes either way. */
function settled(ev: EventOf<'approval.settled' | 'clarify.settled'>, cx: PromptsCx): Outcome {
  cx.sheets.drop(sharedPromptId(ev.payload?.prompt_id))

  return 'render'
}

/** The prompts' events. */
export const promptHandlers = {
  'request.cancel': (ev, cx) => {
    const id = ev.payload?.id
    const notice = promptTimeoutNotice(ev.payload?.method, ev.payload?.reason)
    // Only for a card this window still shows (or holds): an answered one needs no line.
    const held = cx.life.unhold(id)
    const shown = held || cx.sheets.shows(id)

    cx.sheets.drop(id)

    if (notice && shown) {
      cx.transcript.notice(notice, 'warning')
    }

    return 'render'
  },

  'approval.request': asked,
  'clarify.request': asked,
  'approval.settled': settled,
  'clarify.settled': settled,

  'approval.cancelled': (ev, cx) => {
    cx.sheets.dropByApproval(ev.payload?.request_ids)

    return 'render'
  }
} satisfies Handlers<PromptsCx>
