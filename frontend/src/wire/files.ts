// The files and texts this frontend reads that another process wrote: its settings, the watch
// spec a launching pane hands a watcher, the chart rules a pane keeps for a process, and the
// dictation helper's lines. Each is read once, through a schema, into a named type. None carries
// a version: an old pane keeps running the old bundle after a `git pull`, so every format stays
// the one it was.
// A schema falls back where the code before it fell back: a missing or unreadable file and text
// that is not JSON read as they did, and a field of the wrong type reads as absent.

import { readFileSync } from 'node:fs'

import * as z from 'zod/mini'

import { liveSessionId } from '../core/ids.js'
import type { Settings } from '../settings.js'
import type { WatchSpec } from '../watch/spec.js'

import { parseJson } from './json.js'
import { loose } from './schemas.js'

/** The JSON value file `file` holds; undefined when it cannot be read or is not JSON. */
export function readJsonFile(file: string): unknown {
  try {
    return parseJson(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Whether `value` is a JSON object or list: what a spread or a field read takes without a throw. */
function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

// ── settings.json ─────────────────────────────────────────────────────────────────────────────

/** settings.json's fields; one of the wrong type reads as unset (its default), and a file that is not an object as no settings. */
const settingsFile: z.ZodMiniType<Settings> = z.catch(
  z.object({
    theme: loose(z.enum(['tern', 'nous', 'skin'])),
    thoughts: loose(z.boolean()),
    jobCharts: loose(z.boolean()),
    tableCharts: loose(z.enum(['off', 'always', 'smart']))
  }),
  {}
)

/** The settings `file` holds; the defaults ({}) when it cannot be read, is not JSON, or is not an object. */
export function readSettings(file: string): Settings {
  return settingsOf(readStoredSettings(file))
}

/** The settings a stored settings.json value holds. */
export function settingsOf(stored: unknown): Settings {
  return settingsFile.parse(stored)
}

/** settings.json as stored, every key kept, so a save merges into what is there; {} when there is nothing to merge into. */
export function readStoredSettings(file: string): object {
  const stored = readJsonFile(file)

  return isObject(stored) ? stored : {}
}

// ── The watch spec (HERMES_TERN_WATCH) ────────────────────────────────────────────────────────

/** A spec needs the two ids; the rest reads leniently, as the launching pane always writes them. */
const watchSpec: z.ZodMiniType<WatchSpec> = z.object({
  sid: z.pipe(z.string(), z.transform(liveSessionId)),
  subagent: z.string(),
  name: z.catch(z.string(), ''),
  goal: z.catch(z.string(), ''),
  index: z.catch(z.number(), 0),
  startedAt: z.catch(z.number(), 0)
})

/** The watch spec the variable carries; undefined when it is unset, not JSON, or names no session and subagent. */
export function readWatchSpecText(raw: string | undefined): WatchSpec | undefined {
  const spec = watchSpec.safeParse(raw ? parseJson(raw) : undefined)

  return spec.success ? spec.data : undefined
}

// ── Chart memory (plugin-data/hermes-tern/charts/<id>.json) ───────────────────────────────────

const skipped = z.object({ skip: z.number() })

/** A kept decline: the model declined the chart at `skip` lines. Undefined for anything else (rules, or no file). */
export function chartSkip(value: unknown): { skip: number } | undefined {
  return skipped.safeParse(value).data
}

// ── The dictation helper's lines (dictation.py's stdout) ──────────────────────────────────────

/** One line of a capture: the recorder's state, what a streaming STT has heard so far, the final text, or an error. */
export type DictationEvent =
  | { kind: 'state'; state: 'idle' | 'listening' | 'transcribing' }
  | { kind: 'partial'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'error'; message: string }

const dictationLine = z.object({
  error: z.optional(z.string()),
  partial: z.optional(z.string()),
  state: z.optional(z.enum(['idle', 'listening', 'transcribing'])),
  text: z.optional(z.string())
})

/** A capture's line; undefined for a line that is none of them (a state Hermes added later, stray output). */
export function dictationEvent(line: string): DictationEvent | undefined {
  const { data } = dictationLine.safeParse(parseJson(line))

  if (data?.error !== undefined) {
    return { kind: 'error', message: data.error }
  }

  if (data?.state) {
    return { kind: 'state', state: data.state }
  }

  if (data?.text !== undefined) {
    return { kind: 'text', text: data.text }
  }

  return data?.partial === undefined ? undefined : { kind: 'partial', text: data.partial }
}

/** What `dictation.py --check` answered: whether the microphone and the STT provider are set up, and its report. */
export type DictationCheck = { ready: boolean; details: string } | { error: string }

const checkLine = z.object({ details: z.optional(z.string()), error: z.optional(z.string()), ready: z.optional(z.boolean()) })

/** The answer on the last line of `stdout`; undefined when there is none. */
export function readDictationCheck(stdout: string): DictationCheck | undefined {
  const { data } = checkLine.safeParse(parseJson(stdout.trim().split('\n').at(-1) ?? ''))

  if (data?.error !== undefined) {
    return { error: data.error }
  }

  return data?.ready === undefined ? undefined : { details: data.details ?? '', ready: data.ready }
}
