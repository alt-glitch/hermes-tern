import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { imagePathOf } from '../hermes/clipboardImage.js'

describe('imagePathOf', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tern paste-'))
  const shot = join(dir, 'Screen Shot 1.png')
  writeFileSync(shot, 'x')

  it('reads a dropped or pasted image path in every form a terminal types it', () => {
    expect(imagePathOf(shot, '/')).toBe(shot)
    expect(imagePathOf(`'${shot}'`, '/')).toBe(shot)
    expect(imagePathOf(shot.replace(/ /g, '\\ '), '/')).toBe(shot)
    expect(imagePathOf(`file://${encodeURI(shot)}`, '/')).toBe(shot)
    expect(imagePathOf('Screen Shot 1.png', dir)).toBe(shot)
  })

  it('leaves text, other files, missing files and several lines alone', () => {
    expect(imagePathOf('hello there', dir)).toBeUndefined()
    expect(imagePathOf(join(dir, 'notes.txt'), '/')).toBeUndefined()
    expect(imagePathOf(join(dir, 'gone.png'), '/')).toBeUndefined()
    expect(imagePathOf(`${shot}\n${shot}`, '/')).toBeUndefined()
  })
})
