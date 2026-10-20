// Images from the clipboard and from dropped or pasted file paths, as Hermes' Ink TUI takes them
// (ui-tui/src/app/useComposerState.ts). A terminal pastes an image as no text at all, so an empty
// paste, Ctrl+V and `/paste` read the clipboard's image into a file: on macOS straight from the
// pasteboard, elsewhere with Hermes' own extractor (ui-tui/scripts/clipboard_image.py, which
// handles Wayland, X11 and WSL). A paste that is one image path (what a file dropped on the pane
// types) attaches that file.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** Runs a program; resolves its stdout, rejects when it fails or cannot start. */
export type Runner = (
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout: number }
) => Promise<string>

const runFile: Runner = async (file, args, options) => (await execFileP(file, args, options)).stdout

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

/**
 * The clipboard's image as a file: `dest`, written, or (macOS) the image file Finder copied;
 * undefined when the clipboard holds none. On macOS Hermes' extractor runs only when osascript
 * itself fails, not when it finds no image.
 */
export async function extractClipboardImage(
  dest: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  run: Runner = runFile
): Promise<string | undefined> {
  if (platform === 'darwin') {
    let answer: string | undefined

    try {
      answer = (await run('osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT, dest], { timeout: 5_000 })).trim()
    } catch {
      // No answer at all (no osascript, a sandbox): Hermes' extractor may still read it.
    }

    if (answer?.startsWith('file:')) {
      // A copied file that is no image is no clipboard image, nor is the icon beside it.
      const file = answer.slice('file:'.length)

      return IMAGE.test(file) && existsSync(file) ? file : undefined
    }

    if (answer !== undefined) {
      return answer === 'true' && existsSync(dest) ? dest : undefined
    }
  }

  const root = env['HERMES_PYTHON_SRC_ROOT']
  const python = env['HERMES_PYTHON']?.trim() || 'python3'

  if (!root) {
    return undefined
  }

  const stdout = await run(python, [join(root, 'ui-tui/scripts/clipboard_image.py'), dest], {
    cwd: root,
    env: { ...env, PYTHONPATH: root },
    timeout: 15_000
  })

  return stdout.trim() === 'true' && existsSync(dest) ? dest : undefined
}

/**
 * Hands the clipboard's image file to `use` (which uploads its bytes); undefined when the
 * clipboard holds none. A written image's temporary folder goes afterwards, image or not, as in
 * Ink's stageClipboardImage (ui-tui/src/lib/imageAttachments.ts).
 */
export async function withClipboardImage<T>(
  use: (path: string) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
  extract: (dest: string, env: NodeJS.ProcessEnv) => Promise<string | undefined> = extractClipboardImage
): Promise<T | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-tern-clipboard-'))

  try {
    const path = await extract(join(dir, 'clipboard.png'), env)

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
