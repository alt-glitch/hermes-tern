// The launch, read in one place: `hermes tern` passes the pane what it was started with (a session to
// resume, a first prompt, an image, a folder) as one JSON object in HERMES_TERN_LAUNCH, its
// LaunchSpec (backend/launch/launcher.py), and nothing changes it while the pane runs. Read once, its
// fields are plain fields.
//
// Not here: modules that take an `env` parameter (HERMES_HOME's paths, GitHub tokens, the command a
// sidebar runs) keep it, so tests hand them their own.

import * as z from 'zod/mini'

import { type HermesCommand, hermesCommand } from '../hermes/connect.js'
import { parseJson } from '../wire/json.js'

/** The variable `hermes tern` passes its LaunchSpec in. */
export const LAUNCH_ENV = 'HERMES_TERN_LAUNCH'

const text = z.catch(z.string(), '')

/** The launcher's LaunchSpec. A field that is missing or of the wrong type reads as its empty value. */
const launchSpec = z.object({
  create: z.catch(z.record(z.string(), z.unknown()), {}),
  cwd: text,
  hermes: z.catch(z.optional(hermesCommand), undefined),
  image: text,
  pane_cwd: text,
  query: text,
  restored: z.catch(z.boolean(), false),
  resume: text,
  session_cwd: text,
  session_file: text,
  tool_progress: text
})

/** What the launcher said at startup. Every string is '' when the launch does not set it. */
export interface LaunchEnv {
  /** How to run this Hermes (the gateway attach, a sidebar); undefined outside `hermes tern`. */
  readonly hermes: HermesCommand | undefined
  /** Where the shown session's id goes, for the launcher's quit summary ('' for none). */
  readonly sessionFile: string
  /** The launch flags as `session.create` fields (model, provider, skills, yolo, …). */
  readonly create: Readonly<Record<string, unknown>>
  /** `-v` / `-Q`, pinned on each new session ('' for the profile's). */
  readonly toolProgress: string
  /** Trimmed: the session to resume first ('' starts a new one). */
  readonly resume: string
  /** Trimmed: `hermes tern -q …`, the first prompt. */
  readonly query: string
  /** Trimmed: `--image`, attached to the first session. */
  readonly image: string
  /** Trimmed: the folder new sessions start in ('' lets the gateway choose). */
  readonly sessionCwd: string
  /** The launch's folder, else the process's: where the user launched Hermes, for relative paths. */
  readonly cwd: string
  /** HOME as set: undefined when unset, kept as given otherwise. */
  readonly home: string | undefined
  /** HERMES_TERN_EVENT_LOG: the development tap's file ('' for none). */
  readonly eventLog: string
  /** TERN_PANE: the Tern pane this runs in, whose conversation the plugin keeps ('' outside Tern). */
  readonly pane: string
  /** Where `hermes tern` started, before a resume moved to the session's folder; else `cwd`. */
  readonly paneCwd: string
  /** The launcher resumes the pane's conversation after its program died. */
  readonly restored: boolean
}

/**
 * Parses `env` (the process's by default); `cwd` stands in when the launch names no folder.
 * Bracket reads: the environment is an index signature.
 */
export function readLaunchEnv(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): LaunchEnv {
  const raw = env[LAUNCH_ENV]
  const spec = launchSpec.safeParse(raw ? parseJson(raw) : {}).data ?? launchSpec.parse({})
  const launchCwd = spec.cwd || cwd

  return Object.freeze({
    create: Object.freeze({ ...spec.create }),
    cwd: launchCwd,
    eventLog: env['HERMES_TERN_EVENT_LOG'] ?? '',
    hermes: spec.hermes,
    home: env['HOME'],
    image: spec.image.trim(),
    pane: env['TERN_PANE']?.trim() ?? '',
    paneCwd: spec.pane_cwd || launchCwd,
    query: spec.query.trim(),
    restored: spec.restored,
    resume: spec.resume.trim(),
    sessionCwd: spec.session_cwd.trim(),
    sessionFile: spec.session_file,
    toolProgress: spec.tool_progress.trim()
  })
}

let launch: LaunchEnv | undefined

/**
 * This process's LaunchEnv, parsed on first use and the same object after. entry.ts reads it at
 * startup; view helpers with no host to ask (a path shortened for a label) read it here.
 */
export function launchEnv(): LaunchEnv {
  return (launch ??= readLaunchEnv())
}
