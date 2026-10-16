// The shared gateway asks for approvals and clarifications as events bound to one execution
// (`approval.request` / `clarify.request`, gateway/session_pending_controls.py) and takes the
// answer through `approval.respond` / `clarify.respond`, never through a server→client request.
// This turns such an event into the ServerRequest the prompt sheets already answer, so the same
// sheet serves both wires.
import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import type { GatewayClient } from '@tui/gatewayClient.js'

interface SharedPayload extends Record<string, unknown> {
  prompt_id?: string
  execution_generation?: number
  question?: string
  choices?: string[] | null
  multi_select?: boolean
  questions?: unknown
}

/** The request id a shared prompt's sheet carries: `prompt:<id>` is its overlay key. */
export const sharedPromptId = (promptId: unknown) => `shared:${String(promptId)}`

export function sharedPromptRequest(
  ev: { type: string; session_id?: string; payload?: unknown },
  gw: Pick<GatewayClient, 'request'>,
  onError: (message: string) => void
): ServerRequest | null {
  const kind = ev.type === 'approval.request' ? 'approval' : ev.type === 'clarify.request' ? 'clarify' : null
  const shared = (ev.payload ?? {}) as SharedPayload

  if (!kind || !shared.prompt_id || !ev.session_id || typeof shared.execution_generation !== 'number') {
    return null
  }

  const control = { session_id: ev.session_id, execution_generation: shared.execution_generation, prompt_id: shared.prompt_id }
  // One card per question on this wire: the sheet's questions[] shape with the prompt id as its qid.
  const single = typeof shared.question === 'string' ? shared.question.trim() : ''

  const batch = Array.isArray(shared.questions) && shared.questions.length ? shared.questions : null

  const questions =
    batch ??
    (single
      ? [{ choices: shared.choices ?? [], multi_select: shared.multi_select === true, qid: shared.prompt_id, question: single }]
      : [])

  let answered = false

  const send = (method: string, params: Record<string, unknown>) => {
    if (answered) {
      return
    }

    answered = true
    gw.request(method, { ...params, ...control }).catch((error: Error) => onError(error.message))
  }

  return {
    id: sharedPromptId(shared.prompt_id),
    method: kind,
    params: { ...shared, questions, session_id: ev.session_id },
    respond: result =>
      kind === 'approval'
        ? send('approval.respond', { choice: result.choice ?? 'deny' })
        : send('clarify.respond', { answer: firstAnswer(result.answers) }),
    // Unanswered here: the prompt stays pending for another viewer or its own timeout.
    fail: () => undefined
  }
}

/** A clarify sheet answers `{answers: {qid: text}}`; the shared wire takes one answer per card ('' skips). */
function firstAnswer(answers: unknown): string {
  if (!answers || typeof answers !== 'object') {
    return ''
  }

  const first = Object.values(answers)[0]

  return Array.isArray(first) ? first.join(', ') : typeof first === 'string' ? first : ''
}
