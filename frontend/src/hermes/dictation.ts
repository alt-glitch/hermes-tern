// Dictation's parts outside the pane: `dictation.py` at the plugin's root, run in Hermes'
// interpreter (it opens the microphone and calls Hermes' STT), and the record key config.yaml
// names (`voice.record_key`).

import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { type KeyMatch, KEYS } from '../draft/keys.js'
import { type DictationCheck, type DictationEvent, dictationEvent, readDictationCheck } from '../wire/files.js'
import { record } from '../wire/json.js'
import { type Requester, rpc } from '../wire/rpc.js'

/** How long `--check` may take: its first run imports Hermes' audio and STT modules. */
const CHECK_TIMEOUT_MS = 60_000
/** How long a cancelled capture may take to release the microphone and exit before it is killed. */
const CANCEL_GRACE_MS = 10_000

/** One capture in flight. */
export interface Capture {
  /** Ends the capture; its text follows. */
  stop(): void
  /** Ends the capture and keeps nothing. */
  cancel(): void
  /** Settles once the helper has exited (the microphone is released). */
  readonly closed: Promise<void>
}

/** Where captures come from: the helper in Hermes' interpreter, or a fake in the tests. */
export interface Recorder {
  /** Whether this machine can dictate: a microphone and an STT provider, as `/voice status` reports them. */
  check(): Promise<DictationCheck>
  /** Opens the microphone; `on` gets each line until the capture is idle. */
  start(on: (event: DictationEvent) => void): Capture
}

/** The helper in Hermes' interpreter; undefined when the launcher named no interpreter or checkout to run it with. */
export function hermesRecorder(env: NodeJS.ProcessEnv = process.env): Recorder | undefined {
  const python = env['HERMES_PYTHON']?.trim()
  const root = env['HERMES_PYTHON_SRC_ROOT']
  const ui = env['HERMES_TUI_DIR']

  if (!python || !root || !ui) {
    return undefined
  }

  const script = join(ui, '..', 'dictation.py')
  const run = (args: string[]) => spawn(python, [script, ...args], { cwd: root, env: { ...env, PYTHONPATH: root }, stdio: ['pipe', 'pipe', 'ignore'] })

  return {
    check: () =>
      new Promise(resolve => {
        const child = run(['--check'])
        let stdout = ''
        const timer = setTimeout(() => child.kill(), CHECK_TIMEOUT_MS)
        child.stdin.end()
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
        child.on('error', error => resolve({ error: error.message }))
        child.on('close', () => {
          clearTimeout(timer)
          resolve(readDictationCheck(stdout) ?? { error: 'dictation.py gave no answer' })
        })
      }),
    start: on => {
      const child = run([])
      const closed = Promise.withResolvers<void>()
      let rest = ''
      let idle = false
      let killer: NodeJS.Timeout | undefined
      const send = (line: string) => {
        if (child.stdin.writable) {
          child.stdin.write(`${line}\n`)
        }
      }

      child.stdin.on('error', () => undefined)
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        const lines = (rest + chunk).split('\n')
        rest = lines.pop() ?? ''

        for (const line of lines) {
          const event = dictationEvent(line)
          idle ||= event?.kind === 'state' && event.state === 'idle'

          if (event) {
            on(event)
          }
        }
      })
      child.on('error', error => on({ kind: 'error', message: error.message }))
      child.on('close', code => {
        clearTimeout(killer)

        // A helper that died mid-capture still ends it, so the pane never shows a microphone that is closed.
        if (!idle) {
          on(code ? { kind: 'error', message: `dictation.py exited with code ${code}` } : { kind: 'state', state: 'idle' })
        }

        closed.resolve()
      })

      return {
        cancel: () => {
          send('cancel')
          child.stdin.end()
          // Unref'd: a pane that quits does not wait for it; the helper sees stdin close and exits.
          killer ??= setTimeout(() => child.kill(), CANCEL_GRACE_MS).unref()
        },
        closed: closed.promise,
        stop: () => send('stop')
      }
    }
  }
}

/** config.yaml's `voice.record_key`, as the gateway's presentation config hands it out; undefined when it cannot say. */
export async function configuredRecordKey(gw: Requester, sid: string | null): Promise<unknown> {
  try {
    const r = await rpc(gw, 'config.get', { key: 'full', ...(sid ? { session_id: sid } : {}) })

    return record(record(r.config)?.['voice'])?.['record_key']
  } catch {
    return undefined
  }
}

/**
 * The record key in place of Hermes' default Ctrl+B, and of a key this pane cannot take. Tern's
 * editor keeps Ctrl+B for itself (bold, on Linux), so the chat never sees it.
 */
export const DEFAULT_RECORD_KEY: KeyMatch = { label: 'alt+v', name: 'v', with: ['alt'], without: ['ctrl', 'meta'] }

type Modifier = KeyMatch['with'][number]

/** The modifiers Ink's parser accepts (ui-tui/src/lib/platform.ts), by Tern's names: Super (Cmd on macOS) is `meta`. */
const MODIFIERS: Readonly<Record<string, Modifier>> = {
  alt: 'alt',
  control: 'ctrl',
  ctrl: 'ctrl',
  opt: 'alt',
  option: 'alt',
  super: 'meta',
  win: 'meta',
  windows: 'meta'
}

/** The named keys Ink's parser accepts, and their aliases. */
const NAMED: Readonly<Record<string, string>> = {
  backspace: 'backspace',
  bs: 'backspace',
  del: 'delete',
  delete: 'delete',
  enter: 'enter',
  esc: 'escape',
  escape: 'escape',
  ret: 'enter',
  return: 'enter',
  space: 'space',
  spc: 'space',
  tab: 'tab'
}

/**
 * `voice.record_key` as a key the pane matches, in the forms Ink reads it: one modifier and one
 * key (`alt+space`, `super+r`). Anything else, Ctrl+B, and a chord one of this pane's own
 * shortcuts already uses (`ctrl+c`, `alt+p`), is Alt+V, as Ink falls back to its own default.
 */
export function recordKey(raw: unknown): KeyMatch {
  const parts = typeof raw === 'string' ? raw.toLowerCase().split('+').map(p => p.trim()).filter(Boolean) : []
  const [mod = '', last = ''] = parts
  const modifier = MODIFIERS[mod]
  const name = last.length === 1 ? last : NAMED[last]

  if (parts.length !== 2 || !modifier || !name) {
    return DEFAULT_RECORD_KEY
  }

  if ((modifier === 'ctrl' && name === 'b') || Object.values(KEYS).some(k => k.name === name && k.with.includes(modifier))) {
    return DEFAULT_RECORD_KEY
  }

  return {
    label: `${modifier === 'meta' ? 'cmd' : modifier}+${name}`,
    name,
    with: [modifier],
    without: (['alt', 'ctrl', 'meta'] as const).filter(m => m !== modifier)
  }
}
