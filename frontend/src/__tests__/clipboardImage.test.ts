import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { imagePathOf, withClipboardImage } from '../hermes/clipboardImage.js'

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

describe('withClipboardImage', () => {
  const env = { HERMES_PYTHON_SRC_ROOT: '/hermes' }

  it('hands the image to its user, then removes the temporary folder', async () => {
    let seen = ''
    const out = await withClipboardImage(
      async path => {
        seen = path
        expect(existsSync(path)).toBe(true)

        return 'uploaded'
      },
      env,
      async path => (writeFileSync(path, 'png'), true)
    )

    expect(out).toBe('uploaded')
    expect(existsSync(dirname(seen))).toBe(false)
  })

  it('removes the folder when the clipboard holds no image, or the upload fails', async () => {
    let dir = ''
    const none = async (path: string) => ((dir = dirname(path)), false)

    expect(await withClipboardImage(async () => 'never', env, none)).toBeUndefined()
    expect(existsSync(dir)).toBe(false)

    const write = async (path: string) => (writeFileSync(path, 'png'), (dir = dirname(path)), true)
    await expect(withClipboardImage(() => Promise.reject(new Error('gateway down')), env, write)).rejects.toThrow('gateway down')
    expect(existsSync(dir)).toBe(false)
  })

  it('makes no folder without Hermes source to run the extractor from', async () => {
    expect(await withClipboardImage(async () => 'never', {}, async () => true)).toBeUndefined()
  })
})
