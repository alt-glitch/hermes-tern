// The facts list of a preview (a `kv` node): one row per fact that has a value.

import type { KvItem, Spans } from '@stencil-hq/tern'

/** A fact: its name, and its value, or nothing (empty, null, undefined, false) to leave it out. */
export type Fact = readonly [name: string, value: Spans | false | null | undefined]

/** The `kv` items of `list`, in order, without the facts that have no value. */
export function facts(list: readonly Fact[]): KvItem[] {
  return list.flatMap(([name, value]) => (value ? [{ k: [{ t: name }], v: value }] : []))
}
