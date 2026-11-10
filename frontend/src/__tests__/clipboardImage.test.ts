import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { extractClipboardImage, imagePathOf, type Ran, type Runner, withClipboardImage } from '../hermes/clipboardImage.js'
import type { HermesCommand } from '../hermes/connect.js'

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

/** The Hermes command the launcher hands the pane. */
const HERMES: HermesCommand = { argv: ['/venv/bin/python', '-m', 'hermes_cli.main'], env: { HERMES_HOME: '/profile' } }

describe('withClipboardImage', () => {
  it('hands the image to its user, then removes the temporary folder', async () => {
    let seen = ''
    const out = await withClipboardImage(
      async path => {
        seen = path
        expect(existsSync(path)).toBe(true)

        return 'uploaded'
      },
      HERMES,
      async path => (writeFileSync(path, 'png'), path)
    )

    expect(out).toBe('uploaded')
    expect(existsSync(dirname(seen))).toBe(false)
  })

  it('removes the folder when the clipboard holds no image, or the upload fails', async () => {
    let dir = ''
    const none = async (path: string) => ((dir = dirname(path)), undefined)

    expect(await withClipboardImage(async () => 'never', HERMES, none)).toBeUndefined()
    expect(existsSync(dir)).toBe(false)

    const write = async (path: string) => (writeFileSync(path, 'png'), (dir = dirname(path)), path)
    await expect(withClipboardImage(() => Promise.reject(new Error('gateway down')), HERMES, write)).rejects.toThrow('gateway down')
    expect(existsSync(dir)).toBe(false)
  })
})

/** What `hermes clipboard image --json` answers, by its documented result (hermes_cli/clipboard_cmd.py). */
const ANSWERS = {
  image: { code: 0, json: { bytes: 3, mime: 'image/png', ok: true } },
  no_image: { code: 1, json: { message: 'the clipboard holds no image', ok: false, reason: 'no_image' } },
  no_tool: { code: 3, json: { message: 'no clipboard tool found; install one of: wl-paste, xclip', ok: false, reason: 'no_tool', tools: ['wl-paste', 'xclip'] } },
  write_failed: { code: 4, json: { message: 'cannot write /x/clipboard.png: Permission denied', ok: false, reason: 'write_failed' } }
} as const

interface Call {
  file: string
  args: readonly string[]
  env: NodeJS.ProcessEnv | undefined
}

/**
 * A runner that answers osascript with `mac` (writing `dest` for 'true'; an Error: the script did
 * not run) and Hermes' command with `hermes` (writing `--out` for an image), or with `raw` as it is.
 */
function runner(mac: string | Error, hermes: keyof typeof ANSWERS = 'no_image', raw?: Ran) {
  const calls: Call[] = []
  const run: Runner = async (file, args, options) => {
    calls.push({ args, env: options.env, file })

    if (file === 'osascript') {
      if (mac instanceof Error) {
        throw mac
      }

      if (mac === 'true') {
        writeFileSync(must(args.at(-1)), 'png')
      }

      return { code: 0, stderr: '', stdout: `${mac}\n` }
    }

    if (raw) {
      return raw
    }

    const out = must(args[args.indexOf('--out') + 1])
    const { code, json } = ANSWERS[hermes]

    if (hermes === 'image') {
      writeFileSync(out, 'png')
    }

    return { code, stderr: '', stdout: `${JSON.stringify(hermes === 'image' ? { ...json, path: out } : json)}\n` }
  }

  return { calls, run }
}

describe('extractClipboardImage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tern clip-'))
  const finder = join(dir, 'Photo 1.jpg')
  writeFileSync(finder, 'jpg')

  it('macOS: reads the pasteboard with JXA, and runs no Hermes command', async () => {
    const dest = join(dir, 'a.png')
    const r = runner('true')
    expect(await extractClipboardImage(dest, HERMES, 'darwin', r.run)).toBe(dest)
    expect(r.calls.map(c => c.file)).toEqual(['osascript'])

    const none = runner('false')
    expect(await extractClipboardImage(join(dir, 'b.png'), HERMES, 'darwin', none.run)).toBeUndefined()
    expect(none.calls.map(c => c.file)).toEqual(['osascript'])
  })

  it('macOS: a Finder-copied image file is attached as it is; another file is no image', async () => {
    expect(await extractClipboardImage(join(dir, 'c.png'), HERMES, 'darwin', runner(`file:${finder}`).run)).toBe(finder)
    expect(await extractClipboardImage(join(dir, 'c.png'), HERMES, 'darwin', runner(`file:${join(dir, 'notes.txt')}`).run)).toBeUndefined()
  })

  it('macOS: when the JXA script cannot run, Hermes\' command reads the clipboard instead', async () => {
    const dest = join(dir, 'd.png')
    const r = runner(new Error('osascript: not found'), 'image')
    expect(await extractClipboardImage(dest, HERMES, 'darwin', r.run)).toBe(dest)
    expect(r.calls.map(c => c.file)).toEqual(['osascript', '/venv/bin/python'])
  })

  it('elsewhere: runs `hermes clipboard image --out PATH --json` with the launcher\'s command and environment', async () => {
    const dest = join(dir, 'e.png')
    const r = runner('false', 'image')
    expect(await extractClipboardImage(dest, HERMES, 'linux', r.run)).toBe(dest)
    expect(existsSync(dest)).toBe(true)

    const [call] = r.calls
    expect(call?.file).toBe('/venv/bin/python')
    expect(call?.args).toEqual(['-m', 'hermes_cli.main', 'clipboard', 'image', '--out', dest, '--json'])
    expect(call?.env?.['HERMES_HOME']).toBe('/profile')
  })

  it('elsewhere: no_image is no image, not an error', async () => {
    expect(await extractClipboardImage(join(dir, 'f.png'), HERMES, 'win32', runner('false', 'no_image').run)).toBeUndefined()
  })

  it('elsewhere: no_tool and write_failed throw the message the user sees', async () => {
    await expect(extractClipboardImage(join(dir, 'g.png'), HERMES, 'linux', runner('false', 'no_tool').run)).rejects.toThrow(
      'no clipboard tool found; install one of: wl-paste, xclip'
    )
    await expect(extractClipboardImage(join(dir, 'g.png'), HERMES, 'linux', runner('false', 'write_failed').run)).rejects.toThrow(
      'cannot write /x/clipboard.png: Permission denied'
    )
  })

  it('elsewhere: an answer that is no JSON throws its stderr, and no Hermes command at all says so', async () => {
    const usage: Ran = { code: 2, stderr: "hermes: error: argument command: invalid choice: 'clipboard'\n", stdout: '' }
    await expect(extractClipboardImage(join(dir, 'h.png'), HERMES, 'linux', runner('false', 'no_image', usage).run)).rejects.toThrow("invalid choice: 'clipboard'")
    await expect(extractClipboardImage(join(dir, 'h.png'), undefined, 'linux', runner('false').run)).rejects.toThrow(/no Hermes command/)
  })
})
