// A server request read once into the prompt its sheet shows: an approval, a clarify card, or a
// masked value (sudo, a secret, a password manager's prompts). Every field is read leniently, as
// the sheets always read them: a missing or mistyped one is the empty string or false, a
// malformed question or choice is dropped. The sheet, and the stack that keeps it, take the
// parsed prompt; the request goes along only to be answered.

import type {
  ApprovalChoice,
  SecretRequestParams,
  SudoRequestParams,
  VaultCodeRequestParams,
  VaultSaveLoginRequestParams,
  VaultUnlockRequestParams
} from '@hermes/shared/gateway-events'
import type { ServerRequest } from '@hermes/shared/json-rpc-channel'

import { type RequestOf, serverRequest, type Unread } from '../wire/requests.js'

/** A dangerous command waiting on the user's decision. */
export interface ApprovalPrompt {
  kind: 'approval'
  req: ServerRequest
  /** The approval queue's id (what approval.cancelled names); undefined when the request has none. */
  requestId: string | undefined
  command: string
  description: string
  /** The safety check advised against it. */
  smartDenied: boolean
  /** The answers offered, in the sheet's order. */
  choices: ApprovalChoice[]
}

/** One clarify question; a question with no choices takes a typed answer. */
export interface Question {
  qid: string
  question: string
  choices: string[]
  multi: boolean
}

/** clarify's questions (none: nothing to ask), with the answers already locked on a replay. */
export interface ClarifyPrompt {
  kind: 'clarify'
  req: ServerRequest
  questions: Question[]
  answers: Record<string, string | null>
}

/** The methods that ask for one value typed into a field (two for a login). */
export type MaskedMethod = 'secret' | 'sudo' | 'vault.code' | 'vault.save_login' | 'vault.unlock_prompt'

/** A value to type: a sudo password, a secret, a master password, a one-time code or a login. */
export interface MaskedPrompt {
  kind: 'masked'
  req: ServerRequest
  method: MaskedMethod
  /** The command the value unlocks, as sent (sudo's). */
  command: string
  /** The secret's own question, and the variable it fills. */
  prompt: string
  envVar: string
  /** The password manager to unlock: its display name, else its backend. */
  manager: string
  /** The site a code or a login is for: its name, else its origin. */
  site: string
  /** Where the code was sent. */
  hint: string
}

/** What a sheet asks. */
export type PromptRequest = ApprovalPrompt | ClarifyPrompt | MaskedPrompt

/** Every field a masked method may send: each one is read whatever the method. */
type MaskedParams = Unread<SudoRequestParams & SecretRequestParams & VaultUnlockRequestParams & VaultSaveLoginRequestParams & VaultCodeRequestParams>

const text = (v: unknown): string => (typeof v === 'string' ? v : '')

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === 'string') : [])

/** The order the sheet offers the approval answers in. */
const APPROVAL_ORDER: readonly ApprovalChoice[] = ['once', 'session', 'always', 'deny']

/** The prompt `req` asks, or undefined for a method this frontend does not answer. */
export function parsePrompt(req: ServerRequest): PromptRequest | undefined {
  const known = serverRequest(req)

  if (!known) {
    return undefined
  }

  switch (known.method) {
    case 'approval':
      return approvalOf(req, known)

    case 'clarify':
      return { answers: lockedAnswers(known.params.answers), kind: 'clarify', questions: questionsOf(known.params.questions), req }

    case 'sudo':

    case 'secret':

    case 'vault.unlock_prompt':

    case 'vault.code':

    case 'vault.save_login':
      return maskedOf(req, known.method, known.params)

    default:
      return undefined
  }
}

function approvalOf(req: ServerRequest, { params: p }: RequestOf<'approval'>): ApprovalPrompt {
  const smartDenied = p.smart_denied === true
  const offered = strings(p.choices)

  // The TUI's rules: explicit choices win; a smart-guard deny leaves once/deny; no permanent scope drops "always".
  const allowed = new Set<string>(
    offered.length
      ? offered
      : smartDenied
        ? ['once', 'deny']
        : p.allow_permanent === false
          ? ['once', 'session', 'deny']
          : ['once', 'session', 'always', 'deny']
  )

  if (p.allow_session === false) {
    allowed.delete('session')
  }

  return {
    choices: APPROVAL_ORDER.filter(c => allowed.has(c)),
    command: text(p.command),
    description: text(p.description),
    kind: 'approval',
    req,
    requestId: typeof p.request_id === 'string' ? p.request_id : undefined,
    smartDenied
  }
}

/** clarify's questions: those with a qid and a question that is not blank. */
export function questionsOf(raw: unknown): Question[] {
  if (!Array.isArray(raw)) {
    return []
  }

  return raw.flatMap((q: unknown): Question[] => {
    if (!q || typeof q !== 'object' || !('qid' in q) || !('question' in q)) {
      return []
    }

    const question = text(q.question).trim()

    return question
      ? [{ choices: 'choices' in q ? strings(q.choices) : [], multi: 'multi_select' in q && q.multi_select === true, qid: text(q.qid), question }]
      : []
  })
}

/** The answers a replay says the server already locked (a string, or null for skipped). */
function lockedAnswers(preset: unknown): Record<string, string | null> {
  const answers: Record<string, string | null> = {}

  if (preset && typeof preset === 'object') {
    for (const qid in preset) {
      const v: unknown = Reflect.get(preset, qid)

      if (typeof v === 'string' || v === null) {
        answers[qid] = v
      }
    }
  }

  return answers
}

function maskedOf(req: ServerRequest, method: MaskedMethod, p: MaskedParams): MaskedPrompt {
  return {
    command: text(p.command),
    envVar: text(p.env_var),
    hint: text(p.hint),
    kind: 'masked',
    manager: text(p.display_name) || text(p.backend),
    method,
    prompt: text(p.prompt),
    req,
    site: text(p.site) || text(p.origin)
  }
}
