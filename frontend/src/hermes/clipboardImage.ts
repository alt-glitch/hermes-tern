// Images from the clipboard and from dropped or pasted file paths, as Hermes' Ink TUI takes them
// (ui-tui/src/app/useComposerState.ts). A terminal pastes an image as no text at all, so an empty
// paste, Ctrl+V and `/paste` ask Hermes' own extractor (ui-tui/scripts/clipboard_image.py, which
// handles macOS, Wayland, X11 and WSL) to write the clipboard image to a file. A paste that is one
// image path (what a file dropped on the pane types) attaches that file.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const IMAGE = /\.(png|jpe?g|gif|webp)$/i

/** Has Hermes' extractor write the clipboard's image to `path`; false when the clipboard holds none. */
async function extractClipboardImage(path: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const root = env.HERMES_PYTHON_SRC_ROOT
  const python = env.HERMES_PYTHON?.trim() || 'python3'

  if (!root) {
    return false
  }

  const { stdout } = await run(python, [join(root, 'ui-tui/scripts/clipboard_image.py'), path], {
    cwd: root,
    env: { ...env, PYTHONPATH: root },
    timeout: 15_000
  })

  return stdout.trim() === 'true' && existsSync(path)
}

/**
 * Writes the clipboard's image to a temporary file and hands its path to `use` (which uploads its
 * bytes); undefined when the clipboard holds none. The folder goes afterwards, image or not, as in
 * Ink's stageClipboardImage (ui-tui/src/lib/imageAttachments.ts).
 */
export async function withClipboardImage<T>(
  use: (path: string) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
  extract: (path: string, env: NodeJS.ProcessEnv) => Promise<boolean> = extractClipboardImage
): Promise<T | undefined> {
  if (!env.HERMES_PYTHON_SRC_ROOT) {
    return undefined
  }

  const dir = await mkdtemp(join(tmpdir(), 'hermes-tern-clipboard-'))
  const path = join(dir, 'clipboard.png')

  try {
    return (await extract(path, env)) ? await use(path) : undefined
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
