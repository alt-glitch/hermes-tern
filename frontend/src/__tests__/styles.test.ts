// The stylesheet as one hash: the CSS cascade depends on rule order, so a move that splits
// view/styles.ts must keep STYLES byte for byte. A deliberate style change updates the hash
// (`bun run test -u`) in the same commit.
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { STYLES } from '../view/styles.js'

describe('STYLES', () => {
  it('stays byte for byte what it was', () => {
    expect({ bytes: Buffer.byteLength(STYLES), sha256: createHash('sha256').update(STYLES).digest('hex') }).toMatchInlineSnapshot(`
      {
        "bytes": 24379,
        "sha256": "1188093e4fe1f7006fa8450bc77f5fe8a4b2c5fa939a431e197c6914523d145e",
      }
    `)
  })
})
