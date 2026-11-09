// An `ephemeral-ui` fence in an assistant answer: one card.v0 document (kvnloo/ephemeral-ui
// schema/card.v0.json). Only kind and app pick what is drawn; the kit draws its own synthetic
// demo content for that pair, so nothing else in the document reaches the card.
import * as z from 'zod/mini'

import { parseJson } from './json.js'

/** The fence's info string. */
export const EUI_FENCE = 'ephemeral-ui'
const MAX_BYTES = 16 * 1024

const cardDoc = z.object({
  kind: z.string().check(z.regex(/^[a-z][a-z0-9-]{0,39}$/)),
  app: z.string().check(z.regex(/^[a-z0-9][a-z0-9.-]{0,63}$/)),
  title: z.optional(z.string().check(z.maxLength(200)))
})

export interface EuiCardSpec {
  readonly kind: string
  readonly app: string
  readonly title?: string
}

/** The card a fence body asks for, against the pinned kind list; an error line otherwise. */
export function decodeEuiCard(body: string, kinds: readonly string[]): EuiCardSpec | { readonly error: string } {
  if (body.length > MAX_BYTES) {
    return { error: `card is over ${MAX_BYTES} bytes` }
  }

  const parsed = cardDoc.safeParse(parseJson(body))

  if (!parsed.success) {
    return { error: 'not a card.v0 document: needs {"kind": "...", "app": "..."}' }
  }

  if (!kinds.includes(parsed.data.kind)) {
    return { error: `unknown kind ${parsed.data.kind}` }
  }

  const { kind, app, title } = parsed.data

  return title === undefined ? { kind, app } : { kind, app, title }
}
