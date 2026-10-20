// Figures in a finished reply that Tern draws from a fence: ```mermaid through merman, ```svg as a
// picture. A diagram merman cannot parse shows as its source in an empty frame, so after a turn the
// app checks them (figure_check.py, in Hermes' interpreter) and asks the agent once to send the
// broken ones again. Hermes has no hook to keep a turn going after a text-only answer (pre_verify
// fires only after file edits), so the ask is a prompt of its own.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { dataDir } from './connections.js'

export type FigureLang = 'mermaid' | 'svg'

/** A figure fence: its language, source, and its number among the reply's figures of that language. */
export interface Figure {
  lang: FigureLang
  source: string
  n: number
}

export interface FigureFailure extends Figure {
  error: string
  /** The line in the figure's source, when the checker knows it. */
  line?: number
}

export type FigureCheck = (figures: readonly Figure[], signal?: AbortSignal) => Promise<FigureFailure[] | undefined>

const OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/
// A first check downloads merman through uv.
const CHECK_TIMEOUT_MS = 150_000

/** The reply's ```mermaid and ```svg fences, outside any other fence; a fence left open is no figure. */
export function figures(text: string): Figure[] {
  const out: Figure[] = []
  const counts: Record<FigureLang, number> = { mermaid: 0, svg: 0 }
  let open: { mark: string; lang: string; lines: string[] } | undefined

  for (const line of text.split('\n')) {
    if (open) {
      const close = line.trim()

      if (close.length >= open.mark.length && close === open.mark.charAt(0).repeat(close.length)) {
        if (open.lang === 'mermaid' || open.lang === 'svg') {
          out.push({ lang: open.lang, n: ++counts[open.lang], source: open.lines.join('\n') })
        }

        open = undefined
      } else {
        open.lines.push(line)
      }

      continue
    }

    const m = OPEN.exec(line)

    if (m?.[1]) {
      open = { lang: (m[2] ?? '').toLowerCase(), lines: [], mark: m[1] }
    }
  }

  return out
}

const NAME: Record<FigureLang, string> = { mermaid: 'Mermaid diagram', svg: 'SVG figure' }

/** The prompt that asks for the broken figures again. */
export function fixPrompt(failed: readonly FigureFailure[]): string {
  const lines = failed.map(f => `- ${NAME[f.lang]} ${f.n}${f.line ? `, line ${f.line}` : ''}: ${f.error}`)
  const one = failed.length === 1

  return [
    `${one ? 'A figure' : 'Some figures'} in your last reply ${one ? 'does' : 'do'} not render in Tern:`,
    '',
    ...lines,
    '',
    `Send ${one ? 'it' : 'them'} again, fixed, each in its fence, with no other text.`
  ].join('\n')
}

/** True for the one pane that may ask about this reply; other panes showing the session stay quiet. */
export function claimFigures(sid: string, text: string, dir = dataDir()): boolean {
  const key = createHash('sha256').update(`${sid}\0${text}`).digest('hex').slice(0, 32)

  try {
    mkdirSync(join(dir, 'figures'), { recursive: true })
    writeFileSync(join(dir, 'figures', `${key}.asked`), '', { flag: 'wx' })

    return true
  } catch {
    return false
  }
}

/**
 * A {@link FigureCheck} that runs `figure_check.py` in Hermes' interpreter; undefined when the
 * launcher named no interpreter or checkout. It answers undefined when the figures cannot be checked.
 */
export function hermesFigureCheck(env: NodeJS.ProcessEnv = process.env): FigureCheck | undefined {
  const python = env.HERMES_PYTHON?.trim()
  const root = env.HERMES_PYTHON_SRC_ROOT
  const ui = env.HERMES_TUI_DIR

  if (!python || !root || !ui) {
    return undefined
  }

  const script = join(ui, '..', 'figure_check.py')

  return (figs, signal) =>
    new Promise(resolve => {
      const child = spawn(python, ['-I', script], { cwd: root, env, signal, stdio: ['pipe', 'pipe', 'ignore'], timeout: CHECK_TIMEOUT_MS })
      let stdout = ''

      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
      child.on('error', () => resolve(undefined))
      child.stdin.on('error', () => undefined)
      child.on('close', () => {
        try {
          const reply = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as { results?: { ok?: boolean; error?: string; line?: number }[] }
          const results = reply.results

          if (!Array.isArray(results) || results.length !== figs.length) {
            return resolve(undefined)
          }

          resolve(
            figs.flatMap((f, i) => {
              const r = results[i]

              return r?.ok === false ? [{ ...f, error: r.error || 'it does not parse', line: r.line }] : []
            })
          )
        } catch {
          resolve(undefined)
        }
      })
      child.stdin.end(JSON.stringify({ figures: figs.map(f => ({ lang: f.lang, source: f.source })) }))
    })
}
