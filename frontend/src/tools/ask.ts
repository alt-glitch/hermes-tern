// The clarify tool's detail: the questions asked, their choices, and the answers given.

import { list, objects, type Raw, records, text, texts } from './fields.js'

/** One question and the choices it offered. */
export interface AskQuestion {
  question: string | undefined
  choices: string[]
  multi: boolean
}

/** How one question ended: answered, skipped by the user, or left without an answer. */
export type AskStatus = 'answered' | 'skipped' | 'unanswered'

/** The answer to one question: the picks or typed text, and how it ended. */
export interface AskResponse {
  answers: string[]
  status: AskStatus
}

/** How the whole card ended, as the tool reports it. */
export type AskOutcome = 'cancelled' | 'submitted' | 'timed_out' | 'undelivered'

const OUTCOMES: ReadonlySet<string> = new Set<AskOutcome>(['cancelled', 'submitted', 'timed_out', 'undelivered'])

const isOutcome = (v: string | undefined): v is AskOutcome => v !== undefined && OUTCOMES.has(v)

/** A `clarify` call, read once. */
export interface AskDetail {
  tool: 'clarify'
  /** The args' `questions`, or the args themselves when they ask one `question`. */
  questions: AskQuestion[]
  /** Each question's response by index, a hole where an entry is not an object. */
  responses: (AskResponse | undefined)[]
  /** The call has a result. History drops clarify's, so with none the answer is unknown, not missing. */
  answered: boolean
  /** How the card ended; undefined for an older result that does not say. */
  outcome: AskOutcome | undefined
}

export function askDetail({ args, result }: Raw): AskDetail {
  const asked = list(args['questions']) ?? (text(args['question']) ? [args] : [])
  const outcome = text(result?.['outcome'])

  return {
    answered: result !== undefined,
    outcome: isOutcome(outcome) ? outcome : undefined,
    questions: objects(asked).map(q => ({ choices: texts(q['choices']), multi: q['multi_select'] === true, question: text(q['question']) })),
    responses: records(result?.['responses']).map(r => {
      if (!r) {
        return undefined
      }

      // A multi-select answer is a list of picks; a single answer a string.
      const raw = r['user_response']
      const answers = texts(Array.isArray(raw) ? raw : [raw]).filter(a => a.trim())
      const status = r['status'] === 'skipped' ? 'skipped' : answers.length ? 'answered' : 'unanswered'

      return { answers, status }
    }),
    tool: 'clarify'
  }
}

/** The `(Recommended)` suffix the backend adds to clarify's first choice on the wire (the call's args lack it). */
export const RECOMMENDED = /\s*\(recommended\)\s*$/i

/**
 * A question as the sheet and the card show it: the question itself (the sheet's title, the card's
 * head), and the context around it (the agent's reasons, its options spelled out). A question of several
 * paragraphs is asked by its closing one when that is one short line, else by its opening one.
 */
export function splitQuestion(question: string): { ask: string; context: string } {
  const paragraphs = question.trim().split(/\n[ \t]*\n/)
  const [first = '', ...rest] = paragraphs
  const last = paragraphs.at(-1) ?? ''

  if (!rest.length) {
    return { ask: first, context: '' }
  }

  return !last.includes('\n') && last.length <= ASK_MAX ? { ask: last, context: paragraphs.slice(0, -1).join('\n\n') } : { ask: first, context: rest.join('\n\n') }
}

/** The longest closing paragraph read as the question itself. */
const ASK_MAX = 200
