import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { extractClipboardImage, imagePathOf, type Runner, withClipboardImage } from '../hermes/clipboardImage.js'

import { must } from './fakes.js'

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
      async path => (writeFileSync(path, 'png'), path)
    )

    expect(out).toBe('uploaded')
    expect(existsSync(dirname(seen))).toBe(false)
  })

  it('removes the folder when the clipboard holds no image, or the upload fails', async () => {
    let dir = ''
    const none = async (path: string) => ((dir = dirname(path)), undefined)

    expect(await withClipboardImage(async () => 'never', env, none)).toBeUndefined()
    expect(existsSync(dir)).toBe(false)

    const write = async (path: string) => (writeFileSync(path, 'png'), (dir = dirname(path)), path)
    await expect(withClipboardImage(() => Promise.reject(new Error('gateway down')), env, write)).rejects.toThrow('gateway down')
    expect(existsSync(dir)).toBe(false)
  })
})

describe('extractClipboardImage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tern clip-'))
  const finder = join(dir, 'Photo 1.jpg')
  writeFileSync(finder, 'jpg')
  const env = { HERMES_PYTHON_SRC_ROOT: '/hermes' }

  /** A runner that answers osascript with `mac` (writing `dest` for 'true') and python with `py`. */
  function runner(mac: string | Error, py = 'false') {
    const calls: string[] = []
    const run: Runner = async (file, args) => {
      calls.push(file)

      if (file === 'osascript') {
        if (mac instanceof Error) {
          throw mac
        }

        if (mac === 'true') {
          writeFileSync(must(args.at(-1)), 'png')
        }

        return `${mac}\n`
      }

      if (py === 'true') {
        writeFileSync(must(args.at(-1)), 'png')
      }

      return py
    }

    return { calls, run }
  }

  it('macOS: reads the pasteboard with JXA alone, without Hermes’ extractor', async () => {
    const dest = join(dir, 'a.png')
    const r = runner('true')
    expect(await extractClipboardImage(dest, env, 'darwin', r.run)).toBe(dest)
    expect(r.calls).toEqual(['osascript'])
  })

  it('macOS: no image is no image; the extractor is not asked again', async () => {
    const r = runner('false', 'true')
    expect(await extractClipboardImage(join(dir, 'b.png'), env, 'darwin', r.run)).toBeUndefined()
    expect(r.calls).toEqual(['osascript'])
  })

  it('macOS: a Finder-copied image file is attached as it is; another file is no image', async () => {
    expect(await extractClipboardImage(join(dir, 'c.png'), env, 'darwin', runner(`file:${finder}`).run)).toBe(finder)
    expect(await extractClipboardImage(join(dir, 'c.png'), env, 'darwin', runner(`file:${join(dir, 'notes.txt')}`).run)).toBeUndefined()
  })

  it('macOS: falls back to Hermes’ extractor only when osascript fails', async () => {
    const dest = join(dir, 'd.png')
    const r = runner(new Error('osascript: not found'), 'true')
    expect(await extractClipboardImage(dest, env, 'darwin', r.run)).toBe(dest)
    expect(r.calls).toEqual(['osascript', 'python3'])
  })

  it('elsewhere: Hermes’ extractor; nothing without Hermes source to run it from', async () => {
    const dest = join(dir, 'e.png')
    const r = runner('true', 'true')
    expect(await extractClipboardImage(dest, env, 'linux', r.run)).toBe(dest)
    expect(r.calls).toEqual(['python3'])
    expect(await extractClipboardImage(join(dir, 'f.png'), {}, 'linux', runner('true', 'true').run)).toBeUndefined()
  })
})
