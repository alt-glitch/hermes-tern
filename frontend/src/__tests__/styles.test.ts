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
        "bytes": 24266,
        "sha256": "af37fd7ece62437b1d0d1f54e1a65f66bbc7374697b7ca0f6b5eaf3550891f45",
      }
    `)
  })
})
