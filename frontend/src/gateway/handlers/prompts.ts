// The gateway's questions as events: the shared gateway's approval and clarify prompts, their
// settling (answered here or by another viewer), and a request the gateway withdrew.

import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import type { CanonicalClarifyPrompt as ClarifyCard } from '@hermes/shared/gateway-types'

import { sharedPromptId, sharedPromptRequest } from '../../hermes/sharedPrompts.js'
import { promptTimeoutNotice } from '../../overlays/prompts.js'
import type { QuestionPlace } from '../../prompts/parse.js'
import type { PromptSheets } from '../../prompts/sheets.js'
import type { SessionLifecycle } from '../../session/lifecycle.js'
import { RECOMMENDED } from '../../tools/ask.js'
import { detailOf } from '../../tools/detail.js'
import { isAsk } from '../../transcript/calls.js'
import type { Transcript } from '../../transcript/store.js'
import type { Requester } from '../../wire/rpc.js'
import type { EventOf, Handlers, Outcome } from '../dispatch.js'

/** What the prompts' events reach of the app. */
export interface PromptsCx {
  readonly gw: Requester
  readonly life: Pick<SessionLifecycle, 'unhold'>
  readonly sheets: Pick<PromptSheets, 'drop' | 'dropByApproval' | 'shows'>
  readonly transcript: Pick<Transcript, 'lastCall' | 'notice'>
  /** Shows a server request (its sheet), or holds it while a switch is in flight. */
  request(req: ServerRequest): void
  /** Asks for a render. */
  changed(): void
}

/** A shared prompt: the same sheet a server request opens, answered through approval.respond or clarify.respond. */
function asked(ev: EventOf<'approval.request' | 'clarify.request'>, cx: PromptsCx): Outcome {
  const place = ev.type === 'clarify.request' ? placeIn(cx.transcript, ev.payload) : undefined
  const req = sharedPromptRequest(
    ev,
    cx.gw,
    message => {
      cx.transcript.notice(message, 'warning')
      cx.changed()
    },
    place
  )

  if (req) {
    cx.request(req)
  }

  return 'render'
}

/**
 * Where a card's question sits in the running clarify call that asks it: the shared gateway sends
 * a call's questions one card at a time, and only the call's args list them all. The question's
 * text names it, and its choices when two questions read alike; undefined for a call asking one
 * question, when no running call asks it, or when it still matches more than one (an unknown
 * place is better than a wrong one).
 */
function placeIn(transcript: Pick<Transcript, 'lastCall'>, card: ClarifyCard | undefined): QuestionPlace | undefined {
  const asked = typeof card?.question === 'string' ? card.question.trim() : ''
  const call = asked ? transcript.lastCall(c => isAsk(c) && c.outcome.kind === 'running') : undefined
  const d = call ? detailOf(call) : undefined
  const questions = d?.tool === 'clarify' ? d.questions : []
  const offered = (card?.choices ?? []).map(c => c.replace(RECOMMENDED, '')).join('\n')
  const same = questions.flatMap((q, i) => (q.question?.trim() === asked ? [i] : []))
  const matches = same.length > 1 ? same.filter(i => questions[i]?.choices.join('\n') === offered) : same
  const [index] = matches

  return matches.length === 1 && index !== undefined && questions.length > 1 ? { index, total: questions.length } : undefined
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
