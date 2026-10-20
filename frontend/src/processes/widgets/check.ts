// The validator primitives the widget spec is checked with (spec.ts): each reads one value of
// the model's answer, returns it typed or undefined, and on a bad value pushes a message that
// names the place (`blocks[0].field`) into `errors`.

import { oneOf } from '../../core/assert.js'

import type { Better } from './types.js'

/** A field's name: what rules capture into and blocks read. */
export const FIELD_NAME = /^[a-z][a-z0-9_]{0,23}$/

/** `text` cut to `max` characters, the last an ellipsis. */
export const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** An array of `min`–`max` entries. */
export function list(value: unknown, where: string, errors: string[], min: number, max: number): unknown[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${where}: expected an array`)

    return undefined
  }

  if (value.length < min || value.length > max) {
    errors.push(`${where}: expected ${min}–${max} entries, got ${value.length}`)

    return undefined
  }

  return value
}

/** A string, trimmed; blank is absent. `cut` shortens display text and unescapes HTML entities in it. */
export function str(value: unknown, where: string, errors: string[], o: { max?: number; cut?: number; required?: boolean } = {}): string | undefined {
  if (value === undefined || value === null) {
    if (o.required) {
      errors.push(`${where}: required`)
    }

    return undefined
  }

  if (typeof value !== 'string') {
    errors.push(`${where}: expected a string`)

    return undefined
  }

  const trimmed = value.trim()

  if (!trimmed) {
    if (o.required) {
      errors.push(`${where}: must not be empty`)
    }

    return undefined
  }

  if (o.max !== undefined && trimmed.length > o.max) {
    errors.push(`${where}: at most ${o.max} characters`)

    return undefined
  }

  // Display text (titles, labels, units) is cut to fit rather than sent back for a retry, and
  // models sometimes write it HTML-escaped (`ACL &amp; update`).
  return o.cut === undefined ? trimmed : cut(unescape(trimmed), o.cut)
}

const ENTITIES: Record<string, string> = { '&#39;': "'", '&amp;': '&', '&gt;': '>', '&lt;': '<', '&quot;': '"' }

function unescape(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, e => ENTITIES[e] ?? e)
}

/** A finite number, or absent. */
export function num(value: unknown, where: string, errors: string[]): number | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${where}: expected a finite number`)

    return undefined
  }

  return value
}

/** A field's name: lower case, digits and `_`, at most 24 characters. */
export function fieldName(value: unknown, where: string, errors: string[]): string | undefined {
  const name = str(value, where, errors, { required: true })

  if (name !== undefined && !FIELD_NAME.test(name)) {
    errors.push(`${where}: "${name}" must match ${FIELD_NAME.source}`)

    return undefined
  }

  return name
}

/** One of `values` (an aggregation, say). */
export function choice<const T extends string>(value: unknown, values: readonly T[], where: string, errors: string[]): T | undefined {
  if (oneOf(values)(value)) {
    return value
  }

  errors.push(`${where}: expected one of ${values.join(', ')}`)

  return undefined
}

/** Which way a number improves: `higher` or `lower`, or absent. */
export function betterValue(value: unknown, where: string, errors: string[]): Better | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  if (value === 'higher' || value === 'lower') {
    return value
  }

  errors.push(`${where}: expected "higher" or "lower"`)

  return undefined
}
