// Lenient reads of a tool call's args and result, for the parsers in tools/*.ts: a field of the
// wrong type reads as absent, so a card still draws what it can when a tool's shape differs
// between Hermes versions. There is no schema here on purpose (see docs/conventions.md).

import { record } from '../wire/json.js'

/** A string with something in it, else undefined. */
export function text(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/** A number, else undefined. */
export function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}

/** An array as it is, else undefined. */
export function list(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined
}

/** Each item of an array read as an object, a hole where an item is not one; no array reads empty. */
export function records(v: unknown): (Record<string, unknown> | undefined)[] {
  return Array.isArray(v) ? v.map(i => record(i)) : []
}

/** The items of an array that are objects; no array reads empty. */
export function objects(v: unknown): Record<string, unknown>[] {
  return records(v).filter(r => r !== undefined)
}

/** The items of an array that are non-empty strings; no array reads empty. */
export function texts(v: unknown): string[] {
  return Array.isArray(v) ? v.map(i => text(i)).filter(t => t !== undefined) : []
}

/** What a parser reads of a call: its args, and its result as an object (JSON text parsed once). */
export interface Raw {
  args: Record<string, unknown>
  result: Record<string, unknown> | undefined
}
