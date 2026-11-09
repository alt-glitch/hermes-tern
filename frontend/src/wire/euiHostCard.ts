// Trusted host publications are a separate boundary from model-authored card.v0 fences.
import * as z from 'zod/mini'

export const MAX_HOST_CARD_BYTES = 16 * 1024
export const MAX_HOST_ROWS = 32

const text = (max: number) => z.string().check(z.minLength(1), z.maxLength(max))
const hostCard = z.strictObject({
  kind: z.string().check(z.regex(/^[a-z][a-z0-9-]{0,39}$/)),
  app: z.string().check(z.regex(/^[a-z0-9][a-z0-9.-]{0,63}$/)),
  title: text(200),
  summary: z.optional(text(2048)),
  rows: z.array(z.strictObject({
    label: text(80),
    value: z.union([z.string().check(z.maxLength(2048)), z.number(), z.boolean()])
  })).check(z.maxLength(MAX_HOST_ROWS)),
  approval: z.optional(z.strictObject({ label: text(80), description: text(2048) }))
})

export interface EuiHostCardData {
  readonly kind: string
  readonly app: string
  readonly title: string
  readonly summary?: string
  readonly rows: readonly { readonly label: string; readonly value: string | number | boolean }[]
  readonly approval?: { readonly label: string; readonly description: string }
}

/** Reconstruct and freeze displayed fields; no executable, link, style or callback fields. */
export function decodeEuiHostCard(value: unknown, kinds: readonly string[]): EuiHostCardData {
  const parsed = hostCard.safeParse(value)
  if (!parsed.success) throw new TypeError('Invalid host card data')
  const data = parsed.data
  if (!kinds.includes(data.kind)) throw new TypeError('Unknown host card kind')
  if (data.approval && data.kind !== 'approve') throw new TypeError('Only approve cards accept an operation')
  if (!data.title.trim() || data.rows.some(row => !row.label.trim()) ||
    (data.approval && (!data.approval.label.trim() || !data.approval.description.trim()))) {
    throw new TypeError('Host card labels and operation descriptions must not be blank')
  }
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > MAX_HOST_CARD_BYTES) {
    throw new TypeError('Host card exceeds the UTF-8 byte limit')
  }
  return Object.freeze({
    kind: data.kind,
    app: data.app,
    title: data.title,
    rows: Object.freeze(data.rows.map(row => Object.freeze({ label: row.label, value: row.value }))),
    ...(data.summary === undefined ? {} : { summary: data.summary }),
    ...(data.approval === undefined ? {} : { approval: Object.freeze({ ...data.approval }) })
  })
}
