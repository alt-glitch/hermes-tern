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
  const env = {}

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

  /** A runner that answers osascript with `mac` (writing `dest` for 'true'), and runs the Linux readers in `linux` (writing for 'png'). */
  function runner(mac: string | Error, linux: Record<string, 'png' | 'none'> = {}) {
    const calls: string[] = []
    const run: Runner = async (file, args) => {
      if (file === 'osascript') {
        calls.push(file)

        if (mac instanceof Error) {
          throw mac
        }

        if (mac === 'true') {
          writeFileSync(must(args.at(-1)), 'png')
        }

        return `${mac}\n`
      }

      const tool = must(args[1]).split(' ')[0] ?? ''
      calls.push(tool)

      if (linux[tool] !== 'png') {
        writeFileSync(must(args.at(-1)), '')
        throw new Error(`${tool}: no image`)
      }

      writeFileSync(must(args.at(-1)), 'png')

      return ''
    }

    return { calls, run }
  }

  it('macOS: reads the pasteboard with JXA', async () => {
    const dest = join(dir, 'a.png')
    const r = runner('true')
    expect(await extractClipboardImage(dest, {}, 'darwin', r.run)).toBe(dest)
    expect(r.calls).toEqual(['osascript'])
  })

  it('macOS: no image, or no osascript, is no image', async () => {
    expect(await extractClipboardImage(join(dir, 'b.png'), {}, 'darwin', runner('false').run)).toBeUndefined()
    expect(await extractClipboardImage(join(dir, 'b.png'), {}, 'darwin', runner(new Error('osascript: not found')).run)).toBeUndefined()
  })

  it('macOS: a Finder-copied image file is attached as it is; another file is no image', async () => {
    expect(await extractClipboardImage(join(dir, 'c.png'), {}, 'darwin', runner(`file:${finder}`).run)).toBe(finder)
    expect(await extractClipboardImage(join(dir, 'c.png'), {}, 'darwin', runner(`file:${join(dir, 'notes.txt')}`).run)).toBeUndefined()
  })

  it('Linux: wl-paste under Wayland, then xclip under X11; nothing without a display', async () => {
    const both = { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }
    const wayland = runner('false', { 'wl-paste': 'png' })
    expect(await extractClipboardImage(join(dir, 'e.png'), both, 'linux', wayland.run)).toBe(join(dir, 'e.png'))
    expect(wayland.calls).toEqual(['wl-paste'])

    const x11 = runner('false', { xclip: 'png' })
    expect(await extractClipboardImage(join(dir, 'f.png'), both, 'linux', x11.run)).toBe(join(dir, 'f.png'))
    expect(x11.calls).toEqual(['wl-paste', 'xclip'])

    expect(await extractClipboardImage(join(dir, 'g.png'), both, 'linux', runner('false').run)).toBeUndefined()
    const none = runner('false', { xclip: 'png' })
    expect(await extractClipboardImage(join(dir, 'h.png'), {}, 'linux', none.run)).toBeUndefined()
    expect(none.calls).toEqual([])
  })
})
