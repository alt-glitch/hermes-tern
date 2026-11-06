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
        "bytes": 24511,
        "sha256": "43f14f92dd4db7d7d676f1be4251e3302e5bfa72e7e09fcc75f238b58ba91de1",
      }
    `)
  })
})
