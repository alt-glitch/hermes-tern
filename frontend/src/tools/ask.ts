// The clarify tool's detail: the questions asked, their choices, and the answers given.

import { list, objects, type Raw, records, text, texts } from './fields.js'

/** One question and the choices it offered. */
export interface AskQuestion {
  question: string | undefined
  choices: string[]
}

/** The answer to one question: the picks or typed text, or that the user skipped it. */
export interface AskResponse {
  answers: string[]
  skipped: boolean
}

/** A `clarify` call, read once. */
export interface AskDetail {
  tool: 'clarify'
  /** The args' `questions`, or the args themselves when they ask one `question`. */
  questions: AskQuestion[]
  /** Each question's response by index, a hole where an entry is not an object. */
  responses: (AskResponse | undefined)[]
  /** The call has a result. History drops clarify's, so with none the answer is unknown, not missing. */
  answered: boolean
}

export function askDetail({ args, result }: Raw): AskDetail {
  const asked = list(args['questions']) ?? (text(args['question']) ? [args] : [])

  return {
    answered: result !== undefined,
    questions: objects(asked).map(q => ({ choices: texts(q['choices']), question: text(q['question']) })),
    responses: records(result?.['responses']).map(r => {
      if (!r) {
        return undefined
      }

      // A multi-select answer is a list of picks; a single answer a string.
      const raw = r['user_response']

      return { answers: texts(Array.isArray(raw) ? raw : [raw]), skipped: r['status'] === 'skipped' }
    }),
    tool: 'clarify'
  }
}
