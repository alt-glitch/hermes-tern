// Images from the clipboard and from dropped or pasted file paths, as Hermes' Ink TUI takes them
// (ui-tui/src/app/useComposerState.ts). A terminal pastes an image as no text at all, so an empty
// paste, Ctrl+V and `/paste` read the clipboard's image into a file: on macOS straight from the
// pasteboard, elsewhere (and on macOS when that script cannot run) with Hermes' own
// `hermes clipboard image`, which also serves Windows and WSL. A paste that is one image path
// (what a file dropped on the pane types) attaches that file.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import * as z from 'zod/mini'

import { parseJson } from '../wire/json.js'

import type { HermesCommand } from './connect.js'

/** What a run of a program gave: its exit code (0 on success) and its output. */
export interface Ran {
  code: number
  stdout: string
  stderr: string
}

/** Runs a program; resolves how it exited (a non-zero exit too), rejects when it cannot start or times out. */
export type Runner = (file: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; timeout: number }) => Promise<Ran>

const runFile: Runner = (file, args, options) =>
  new Promise((done, fail) => {
    execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      // A program that ran and exited non-zero has a numeric code; one that never started has none.
      if (error && !Number.isInteger(error.code)) {
        return fail(error)
      }

      done({ code: error ? Number(error.code) : 0, stderr, stdout })
    })
  })

const IMAGE = /\.(png|jpe?g|gif|webp)$/i

/**
 * macOS: the pasteboard read by JXA, in a tenth of the time Hermes' extractor takes (python, then
 * two osascript calls). A Finder-copied file (`public.file-url`; its icon rides along as a TIFF,
 * so it goes first) answers `file:<path>`, as Hermes' clipboard.py reads «class furl»; a bitmap
 * (PNG, else TIFF turned PNG) is written to argv[0]; `false` when the pasteboard holds neither.
 */
const MAC_SCRIPT = `ObjC.import('AppKit');
function run(argv) {
  const pb = $.NSPasteboard.generalPasteboard;
  const url = pb.stringForType('public.file-url');
  if (url && !url.isNil()) {
    const path = $.NSURL.URLWithString(url).path;
    if (path && !path.isNil()) return 'file:' + path.js;
  }
  let d = pb.dataForType('public.png');
  if (!d || d.isNil()) {
    const t = pb.dataForType('public.tiff');
    if (!t || t.isNil()) return 'false';
    const rep = $.NSBitmapImageRep.imageRepWithData(t);
    if (!rep || rep.isNil()) return 'false';
    d = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  }
  return d && !d.isNil() && d.writeToFileAtomically(argv[0], true) ? 'true' : 'false';
}`

/** The pasteboard's image as the JXA script reads it; null when the script did not run, so Hermes' command reads it instead. */
async function macClipboardImage(dest: string, run: Runner): Promise<string | undefined | null> {
  const ran = await run('osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT, dest], { timeout: 5_000 }).catch(() => undefined)

  if (!ran || ran.code !== 0) {
    return null
  }

  const answer = ran.stdout.trim()

  if (answer.startsWith('file:')) {
    // A copied file that is no image is no clipboard image, nor is the icon beside it.
    const file = answer.slice('file:'.length)

    return IMAGE.test(file) && existsSync(file) ? file : undefined
  }

  return answer === 'true' && existsSync(dest) ? dest : undefined
}

/** Python starts, then the platform's clipboard tool runs. */
const HERMES_TIMEOUT_MS = 15_000

/** `hermes clipboard image --json`'s answer: the written file, or why there is none. */
const clipboardAnswer = z.union([
  z.object({ ok: z.literal(true), path: z.string() }),
  z.object({ message: z.string(), ok: z.literal(false), reason: z.string() })
])

/**
 * The clipboard's image written to `dest` by `hermes clipboard image --out dest --json`; undefined
 * when the clipboard holds none (`no_image`). Any other answer (`no_tool`, `write_failed`, no JSON)
 * throws its message, which the user sees.
 */
async function hermesClipboardImage(dest: string, hermes: HermesCommand | undefined, run: Runner): Promise<string | undefined> {
  if (!hermes) {
    throw new Error('no Hermes command to read the clipboard with (start the pane with `hermes tern`)')
  }

  const [file, ...args] = hermes.argv
  const ran = await run(file, [...args, 'clipboard', 'image', '--out', dest, '--json'], {
    env: { ...process.env, ...hermes.env },
    timeout: HERMES_TIMEOUT_MS
  })
  const answer = clipboardAnswer.safeParse(parseJson(ran.stdout.trim())).data

  if (answer?.ok && ran.code === 0) {
    return answer.path
  }

  if (answer && !answer.ok && answer.reason === 'no_image') {
    return undefined
  }

  throw new Error((answer && !answer.ok && answer.message) || ran.stderr.trim() || `hermes clipboard image exited ${ran.code}`)
}

/**
 * The clipboard's image as a file: `dest`, written, or (macOS) the image file Finder copied;
 * undefined when the clipboard holds none. `hermes` runs Hermes' command where the macOS script
 * does not serve.
 */
export async function extractClipboardImage(
  dest: string,
  hermes: HermesCommand | undefined,
  platform: NodeJS.Platform = process.platform,
  run: Runner = runFile
): Promise<string | undefined> {
  const mac = platform === 'darwin' ? await macClipboardImage(dest, run) : null

  return mac === null ? hermesClipboardImage(dest, hermes, run) : mac
}

/**
 * Hands the clipboard's image file to `use` (which uploads its bytes); undefined when the
 * clipboard holds none. A written image's temporary folder goes afterwards, image or not, as in
 * Ink's stageClipboardImage (ui-tui/src/lib/imageAttachments.ts).
 */
export async function withClipboardImage<T>(
  use: (path: string) => Promise<T>,
  hermes: HermesCommand | undefined,
  extract: (dest: string, hermes: HermesCommand | undefined) => Promise<string | undefined> = extractClipboardImage
): Promise<T | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-tern-clipboard-'))

  try {
    const path = await extract(join(dir, 'clipboard.png'), hermes)

    return path ? await use(path) : undefined
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

/**
 * The image file a paste names: one line that is a path (quoted, `file://`, `~/`, or with `\ `
 * escapes, as Finder drops type it) to an existing PNG, JPEG, GIF or WebP; undefined otherwise.
 */
export function imagePathOf(text: string, cwd: string): string | undefined {
  let raw = text.trim()

  if (!raw || raw.includes('\n')) {
    return undefined
  }

  raw = raw.replace(/^(['"])(.*)\1$/, '$2')

  if (raw.startsWith('file://')) {
    try {
      raw = decodeURIComponent(new URL(raw).pathname)
    } catch {
      return undefined
    }
  }

  raw = raw.replace(/\\(.)/g, '$1').replace(/^~(?=$|\/)/, homedir())

  if (!IMAGE.test(raw)) {
    return undefined
  }

  const path = resolve(cwd, raw)

  return existsSync(path) ? path : undefined
}
