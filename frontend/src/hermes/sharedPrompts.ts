// The shared gateway asks for approvals and clarifications as events bound to one execution
// (`approval.request` / `clarify.request`, gateway/session_pending_controls.py) and takes the
// answer through `approval.respond` / `clarify.respond`, never through a server→client request.
// This turns such an event into the ServerRequest the prompt sheets already answer, so the same
// sheet serves both wires. Its `respond` returns the RPC: the sheet closes once the answer lands
// and stays open to retry when the gateway refuses it.
import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import type { AnyGatewayEvent, CanonicalClarifyPrompt } from '@tui/gatewayTypes.js'

import { type Requester, type ResultOf, rpc } from '../wire/rpc.js'

/** The shared gateway's prompt events. */
export type SharedPromptEvent = Extract<AnyGatewayEvent, { type: 'approval.request' | 'clarify.request' }>

/** The request id a shared prompt's sheet carries: `prompt:<id>` is its overlay key. */
export const sharedPromptId = (promptId: unknown) => `shared:${String(promptId)}`

export function sharedPromptRequest(ev: SharedPromptEvent, gw: Requester, onNotice: (message: string) => void): ServerRequest | null {
  const kind = ev.type === 'approval.request' ? 'approval' : 'clarify'
  const shared = ev.payload

  if (!shared?.prompt_id || !ev.session_id || typeof shared.execution_generation !== 'number') {
    return null
  }

  const control = { session_id: ev.session_id, execution_generation: shared.execution_generation, prompt_id: shared.prompt_id }
  // One card per question on this wire: the sheet's questions[] shape with the prompt id as its qid.
  const questions = ev.type === 'clarify.request' ? clarifyQuestions(ev.payload, shared.prompt_id) : []

  /** The answer in flight or landed: a second one waits on it, never sends again. */
  let answered: Promise<void> | undefined

  const send = (respond: () => Promise<ResultOf<'approval.respond' | 'clarify.respond'>>) => {
    answered ??= respond().then(
      r => {
        if (r && 'status' in r && r.status === 'already_resolved') {
          onNotice('That question was already answered (by another window, or it timed out).')
        }
      },
      (error: unknown) => {
        // Refused or lost: the sheet shows why and may answer again.
        answered = undefined

        throw error
      }
    )

    return answered
  }

  return {
    id: sharedPromptId(shared.prompt_id),
    method: kind,
    params: { ...shared, questions, session_id: ev.session_id },
    respond: ({ answers, choice }) =>
      kind === 'approval'
        ? send(() => rpc(gw, 'approval.respond', { choice: typeof choice === 'string' ? choice : 'deny', ...control }))
        : send(() => rpc(gw, 'clarify.respond', { answer: firstAnswer(answers), ...control })),
    // Unanswered here: the prompt stays pending for another viewer or its own timeout.
    fail: () => undefined
  }
}

/** A clarify event's questions: its batch, else its one question; none when it asks nothing. */
function clarifyQuestions(clarify: CanonicalClarifyPrompt | undefined, promptId: string) {
  const single = typeof clarify?.question === 'string' ? clarify.question.trim() : ''
  const batch = Array.isArray(clarify?.questions) && clarify.questions.length ? clarify.questions : null

  return (
    batch ??
    (single ? [{ choices: clarify?.choices ?? [], multi_select: clarify?.multi_select === true, qid: promptId, question: single }] : [])
  )
}

/** A clarify sheet answers `{answers: {qid: text}}`; the shared wire takes one answer per card ('' skips). */
function firstAnswer(answers: unknown): string {
  if (!answers || typeof answers !== 'object') {
    return ''
  }

  const first = Object.values(answers)[0]

  return Array.isArray(first) ? first.join(', ') : typeof first === 'string' ? first : ''
}
