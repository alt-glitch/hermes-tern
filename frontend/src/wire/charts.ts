// The chart author's reply: the payload of the plugin event `plugin.hermes-tern.charts.authored`
// that the plugin's Python half (charts.py) sends to the session once the model answered.

import * as z from 'zod/mini'

/** What the model answered for request `job`: the rules, an answer to ask again about, that no auxiliary model is set up, or the error. */
export type ChartReply =
  | { job: string; kind: 'answer'; answer: unknown }
  | { job: string; kind: 'rejected'; answer: string; errors: string[] }
  | { job: string; kind: 'unavailable' }
  | { job: string; kind: 'error'; message: string }

const reply = z.object({
  job: z.string(),
  answer: z.optional(z.unknown()),
  rejected: z.optional(z.object({ answer: z.catch(z.string(), ''), errors: z.catch(z.array(z.string()), []) })),
  unavailable: z.optional(z.unknown()),
  error: z.optional(z.unknown())
})

/** The reply `payload` carries; undefined when it names no job. */
export function readChartReply(payload: unknown): ChartReply | undefined {
  const parsed = reply.safeParse(payload)

  if (!parsed.success) {
    return undefined
  }

  const { answer, error, job, rejected, unavailable } = parsed.data

  if (unavailable) {
    return { job, kind: 'unavailable' }
  }

  if (error) {
    return { job, kind: 'error', message: String(error) }
  }

  if (rejected) {
    return { answer: rejected.answer, errors: rejected.errors.length ? rejected.errors : ['the answer was refused'], job, kind: 'rejected' }
  }

  return { answer, job, kind: 'answer' }
}
