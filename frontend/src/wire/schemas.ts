// Schemas for the gateway shapes that differ between gateway versions: the rows of process.list,
// the counters of a session.usage tick and the shared gateway's FIFO (`pending_submissions`).
// Each one reads what it can and falls back where the code before it fell back: a malformed row is
// skipped, a missing list reads as none.

import type { SessionLiveInfo } from '@hermes/shared/gateway-events'
import type { SessionInfo } from '@tui/types.js'
import * as z from 'zod/mini'

import { oneOf } from '../core/assert.js'
import { type AdmissionId, admissionId, type InputId, inputId } from '../core/ids.js'
import type { Counters } from '../model.js'

/** `schema`, or undefined when the field is missing or not that shape (the old code read it unchecked). */
const loose = <T>(schema: z.ZodMiniType<T>) => z.catch(z.optional(schema), undefined)

/** Keeps the items `item` reads and drops the rest. */
function rowsOf<T>(item: z.ZodMiniType<T>, items: readonly unknown[]): T[] {
  return items.flatMap(raw => {
    const row = item.safeParse(raw)

    return row.success ? [row.data] : []
  })
}

/**
 * One row of `process.list`. The shared gateway (gateway/session_ancillary.py `process_snapshot`)
 * sends `started_epoch` and a 32k `output_tail`; the per-session gateway
 * (tools/process_registry.py `list_sessions`) sends `uptime_seconds` and `output_preview`.
 * Neither says how a process notifies: that is only in the terminal call's arguments.
 */
const processRow = z.object({
  session_id: z.string(),
  command: loose(z.string()),
  status: loose(z.string()),
  exit_code: loose(z.nullable(z.number())),
  started_epoch: loose(z.nullable(z.number())),
  uptime_seconds: loose(z.nullable(z.number())),
  exited_at: loose(z.nullable(z.number())),
  completion_reason: loose(z.nullable(z.string())),
  output_tail: loose(z.nullable(z.string())),
  output_preview: loose(z.string())
})

/** One row of `process.list`, either gateway's. */
export type ProcessRow = z.infer<typeof processRow>

/** `process.list`'s answer as its rows; an answer with no list reads as none, and a row with no id is skipped. */
export const processList = z.pipe(
  z.catch(z.object({ processes: z.nullish(z.array(z.unknown())) }), {}),
  z.transform(answer => rowsOf(processRow, answer.processes ?? []))
)

/** A FIFO row's status as the authority sends it (`AdmissionStatus.status`). */
const PENDING_STATUSES = ['queued', 'started', 'unknown', 'terminal'] as const
const isPendingStatus = oneOf(PENDING_STATUSES)

/** A FIFO row's status; one this client does not know reads as `other`: neither waiting nor started. */
export type PendingStatus = (typeof PENDING_STATUSES)[number] | 'other'

type InfoRow = NonNullable<SessionInfo['pending_submissions']>[number]

/** One row of the authority's FIFO (`info.pending_submissions`), as the queue reads it. */
export interface PendingRow extends Pick<InfoRow, 'user'> {
  admission_id: AdmissionId
  input_id?: InputId | undefined
  status: PendingStatus
}

const pendingRow: z.ZodMiniType<PendingRow> = z.object({
  admission_id: z.pipe(z.string(), z.transform(admissionId)),
  /** The submission id the submitter chose (this pane's `submission_id`). */
  input_id: loose(z.pipe(z.string(), z.transform(inputId))),
  status: z.pipe(z.optional(z.unknown()), z.transform((status): PendingStatus => (isPendingStatus(status) ? status : 'other'))),
  /** The prompt's text. */
  user: z.catch(z.string(), '')
})

/**
 * The shared gateway's FIFO on a session.info or snapshot `info` (the client maps `pending` to
 * it): undefined when `info` carries none, so the queue keeps the rows it has.
 */
export function pendingRows(info: SessionLiveInfo | null | undefined): PendingRow[] | undefined {
  const { pending_submissions: rows } = info ?? {}

  return Array.isArray(rows) ? rowsOf(pendingRow, rows) : undefined
}

/** A counter as the tick was read before: missing is 0, anything else goes through Number (NaN refuses the tick). */
const counter = z.pipe(z.optional(z.unknown()), z.transform(value => Number(value ?? 0)))

/** A tick that is not an object carries no counters. */
const tick = z.catch(
  z.object({
    prompt_tokens: counter,
    cache_read_tokens: counter,
    total_tokens: counter,
    tokens_per_s: loose(z.number())
  }),
  { cache_read_tokens: 0, prompt_tokens: 0, tokens_per_s: undefined, total_tokens: 0 }
)

/**
 * The cumulative counters a session.usage tick carries at its top level (the shared owner's);
 * an older gateway nests its usage under `usage` and sends none, which reads as zeros. Undefined
 * when a counter is not a finite number.
 */
export function usageCounters(payload: unknown): { counters: Counters; tps: number | undefined } | undefined {
  const parsed = tick.parse(payload)
  const counters = { prompt: parsed.prompt_tokens, read: parsed.cache_read_tokens, total: parsed.total_tokens }

  return Object.values(counters).every(Number.isFinite) ? { counters, tps: parsed.tokens_per_s } : undefined
}
