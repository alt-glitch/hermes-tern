// Small type-level guards and helpers shared by every module.

/** A list with at least one item, so `list[0]` needs no check. */
export type NonEmpty<T> = [T, ...T[]]

/** Whether `list` has an item; narrows it to NonEmpty. */
export function isNonEmpty<T>(list: T[]): list is NonEmpty<T> {
  return list.length > 0
}

/**
 * The default arm of an exhaustive switch: the compiler rejects the call while a variant is
 * unhandled, and a value no variant names (data newer than this code) throws.
 */
export function assertNever(value: never, what = 'variant'): never {
  throw new Error(`Unexpected ${what}: ${shown(value)}`)
}

/** Whether `value` is neither undefined nor null; as a filter, it drops the holes from a list. */
export function isDefined<T>(value: T): value is NonNullable<T> {
  return value !== undefined && value !== null
}

/**
 * `{ [key]: value }` when `value` is defined, else `{}`: an optional prop or field spread in only
 * when there is one, so a type that says `key?: V` (exactOptionalPropertyTypes) never gets an
 * explicit undefined. Spread it where the field was, so the key order stays the same.
 */
export function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  const out: { [P in K]?: V } = {}

  if (value !== undefined) {
    out[key] = value
  }

  return out
}

/** A guard for one of `values`: `oneOf(['a', 'b'])(x)` narrows unknown `x` to `'a' | 'b'`. */
export function oneOf<const T extends string>(values: readonly T[]): (value: unknown) => value is T {
  const known: ReadonlySet<unknown> = new Set(values)

  return (value): value is T => known.has(value)
}

function shown(value: unknown): string {
  try {
    return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  } catch {
    return String(value)
  }
}
