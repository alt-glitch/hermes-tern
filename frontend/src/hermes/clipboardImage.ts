// Images from the clipboard and from dropped or pasted file paths, as Hermes' Ink TUI takes them
// (ui-tui/src/app/useComposerState.ts). A terminal pastes an image as no text at all, so an empty
// paste, Ctrl+V and `/paste` ask Hermes' own extractor (ui-tui/scripts/clipboard_image.py, which
// handles macOS, Wayland, X11 and WSL) to write the clipboard image to a file. A paste that is one
// image path (what a file dropped on the pane types) attaches that file.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const IMAGE = /\.(png|jpe?g|gif|webp)$/i

/** Writes the clipboard's image to a new file; its path, or undefined when the clipboard holds none. */
export async function clipboardImage(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const root = env.HERMES_PYTHON_SRC_ROOT
  const python = env.HERMES_PYTHON?.trim() || 'python3'

  if (!root) {
    return undefined
  }

  const path = join(await mkdtemp(join(tmpdir(), 'hermes-tern-clipboard-')), 'clipboard.png')
  const { stdout } = await run(python, [join(root, 'ui-tui/scripts/clipboard_image.py'), path], {
    cwd: root,
    env: { ...env, PYTHONPATH: root },
    timeout: 15_000
  })

  return stdout.trim() === 'true' && existsSync(path) ? path : undefined
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
