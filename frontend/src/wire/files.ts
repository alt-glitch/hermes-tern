// The files and texts this frontend reads that another process wrote: its settings, the watch
// spec a launching pane hands a watcher, the connection cards and the PR links the plugin's Python
// half writes, the chart rules a pane keeps for a process, the chart author's reply, and the
// dictation helper's lines. Each is read once, through a schema, into a named type. None carries
// a version: an old pane keeps running the old bundle after a `git pull`, so every format stays
// the one it was.
// A schema falls back where the code before it fell back: a missing or unreadable file and text
// that is not JSON read as they did, and a field of the wrong type reads as absent.

import { readFileSync } from 'node:fs'

import * as z from 'zod/mini'

import type { SettleReason } from '../connections/cards.js'
import { liveSessionId, storedSessionId } from '../core/ids.js'
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
    jobCharts: loose(z.boolean())
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
  stored: loose(z.pipe(z.string(), z.transform(storedSessionId))),
  subagent: z.string(),
  name: z.catch(z.string(), ''),
  goal: z.catch(z.string(), ''),
  index: z.catch(z.number(), 0),
  log: loose(z.string()),
  startedAt: z.catch(z.number(), 0)
})

/** The watch spec the variable carries; undefined when it is unset, not JSON, or names no session and subagent. */
export function readWatchSpecText(raw: string | undefined): WatchSpec | undefined {
  const spec = watchSpec.safeParse(raw ? parseJson(raw) : undefined)

  return spec.success ? spec.data : undefined
}

// ── Connection cards (plugin-data/hermes-tern/connections/<key>.json, connections.py) ─────────

/** The settle reasons the watcher writes (`settled_by`); `stopped` is the pane's own. */
const SETTLED_BY = ['all_resolved', 'continued', 'deadline', 'error', 'superseded'] as const satisfies readonly SettleReason[]

/** A card file as connections.py `_Card.data` writes it, the fields the pane reads. */
const cardFile = z.object({
  /** Each app's row: kept as written, read by connections/cards.ts as a tool result's rows are. */
  targets: z.array(z.unknown()),
  error: loose(z.string()),
  /** Epoch seconds of the watcher's last write. */
  updated_at: loose(z.number()),
  /** Why the card stopped; another value reads as none. */
  settled_by: loose(z.enum(SETTLED_BY)),
  watching: loose(z.boolean()),
  /** The watcher's process. */
  pid: loose(z.number())
})

/** A card file's fields. */
export type CardData = z.infer<typeof cardFile>

/** The card `file` holds; undefined when it cannot be read, is not JSON, or has no list of targets. */
export function readCardFile(file: string): CardData | undefined {
  const card = cardFile.safeParse(readJsonFile(file))

  return card.success ? card.data : undefined
}

const created = z.object({ created_at: z.number() })

/** When card `file` was written (epoch seconds); 0 when it cannot be read or says none. */
export function cardCreatedAt(file: string): number {
  return created.safeParse(readJsonFile(file)).data?.created_at ?? 0
}

// ── PR links (plugin-data/hermes-tern/pull-requests.json, pull_requests.py) ───────────────────

const linksFile = z.catch(
  z.object({
    /** Session id → the conversation root its links are filed under; a non-text root reads as none. */
    aliases: z.catch(z.record(z.string(), loose(z.string())), {}),
    /** Root → its links, read by links.ts as a tool result's are. */
    conversations: z.catch(z.record(z.string(), z.unknown()), {})
  }),
  { aliases: {}, conversations: {} }
)

/** pull-requests.json's two maps. */
export type LinksFile = z.infer<typeof linksFile>

/**
 * The links file's maps; undefined when it cannot be read or is not JSON, and empty maps for JSON
 * that is not an object. A file holding `null` throws, as reading `data.aliases` on it did before
 * the schema.
 */
export function readLinksFile(file: string): LinksFile | undefined {
  const data = readJsonFile(file)

  if (data === null) {
    throw new TypeError('pull-requests.json holds null')
  }

  return data === undefined ? undefined : linksFile.parse(data)
}

// ── Chart memory (plugin-data/hermes-tern/charts/<id>.json) ───────────────────────────────────

const skipped = z.object({ skip: z.number() })

/** A kept decline: the model declined the chart at `skip` lines. Undefined for anything else (rules, or no file). */
export function chartSkip(value: unknown): { skip: number } | undefined {
  return skipped.safeParse(value).data
}

// ── The chart author's reply (widget_author.py's last stdout line) ────────────────────────────

/** What widget_author.py answered: the rules, that no auxiliary model is set up, or its error. */
export type AuthorReply = { kind: 'answer'; answer: unknown } | { kind: 'unavailable' } | { kind: 'error'; message: string }

/** A reply that is not an object reads as an answer of nothing. */
const reply = z.catch(z.object({ answer: z.optional(z.unknown()), error: z.optional(z.unknown()), unavailable: z.optional(z.unknown()) }), {
  answer: undefined,
  error: undefined,
  unavailable: undefined
})

/** The reply on the last line of `stdout`; undefined when that line is not JSON, or is `null`. */
export function readAuthorReply(stdout: string): AuthorReply | undefined {
  const line = parseJson(stdout.trim().split('\n').at(-1) ?? '')

  if (line === undefined || line === null) {
    return undefined
  }

  const { answer, error, unavailable } = reply.parse(line)

  if (unavailable) {
    return { kind: 'unavailable' }
  }

  return error ? { kind: 'error', message: String(error) } : { kind: 'answer', answer }
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
