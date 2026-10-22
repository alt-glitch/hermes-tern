// Rows from the profile's `state.db`, which Hermes writes and this frontend reads read-only (the
// session picker, a subagent's transcript, the compaction boundaries, a session's lineage). A row
// is read through a schema into a named type, in place of a cast; the schemas read the columns the
// way the code before them did, so a row the old code took is still taken.

import type { SQLInputValue, StatementSync } from 'node:sqlite'

import * as z from 'zod/mini'

import { loose, rowsOf } from './schemas.js'

/** A TEXT column that may be NULL; any other value reads as NULL. */
export const text = z.catch(z.nullable(z.string()), null)

const utf8 = new TextDecoder()

/**
 * A TEXT column selected as `CAST(col AS BLOB)`, decoded whole; NULL or any other value reads as
 * NULL. Node 22's node:sqlite cuts TEXT at its first NUL byte, and Hermes stores structured
 * content behind one (`\x00json:`).
 */
export const textBytes = z.catch(
  z.pipe(
    z.nullable(z.instanceof(Uint8Array)),
    z.transform(bytes => (bytes ? utf8.decode(bytes) : null))
  ),
  null
)

/** A numeric column that may be NULL; any other value reads as NULL. */
export const real = z.catch(z.nullable(z.number()), null)

/** The rows `stmt` returns for `params`, each read by `row`; a row `row` cannot read is skipped. */
export function rows<T>(stmt: Pick<StatementSync, 'all'>, row: z.ZodMiniType<T>, ...params: SQLInputValue[]): T[] {
  return rowsOf(row, stmt.all(...params))
}

/** The first row `stmt` returns for `params`, read by `row`; undefined for none, or one `row` cannot read. */
export function first<T>(stmt: StatementSync, row: z.ZodMiniType<T>, ...params: SQLInputValue[]): T | undefined {
  const read = row.safeParse(stmt.get(...params))

  return read.success ? read.data : undefined
}

/** One call an assistant row made, from its `tool_calls` JSON (the OpenAI shape Hermes stores). */
export interface StoredCall {
  id?: string | null | undefined
  call_id?: string | null | undefined
  function?: { name?: string | undefined; arguments?: string | undefined } | undefined
}

/** A call that is not an object reads as one with no fields (a tool row named `tool`, no arguments). */
const storedCall: z.ZodMiniType<StoredCall> = z.catch(
  z.object({
    id: loose(z.nullable(z.string())),
    call_id: loose(z.nullable(z.string())),
    function: loose(z.object({ name: loose(z.string()), arguments: loose(z.string()) }))
  }),
  {}
)

/**
 * The calls in a `tool_calls` column: none for NULL, text that is not JSON, or JSON that is not a
 * list. A null in the list throws, as reading `call.function` on it did before the schema.
 */
export function storedCalls(raw: string | null): StoredCall[] {
  let list: unknown

  try {
    list = raw ? JSON.parse(raw) : []
  } catch {
    return []
  }

  if (!Array.isArray(list)) {
    return []
  }

  return list.map((call: unknown) => {
    if (call === null) {
      throw new TypeError('A stored tool call is null')
    }

    return storedCall.parse(call)
  })
}

/** A call's arguments: the JSON object its `arguments` text holds; {} for none, or for text that is not one. */
export function storedArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {}

    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
