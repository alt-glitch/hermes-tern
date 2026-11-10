// The launcher's environment, read in one place: `hermes tern` passes the pane what it was started
// with (a session to resume, a first prompt, an image, a folder) as variables, and nothing changes
// them while the pane runs. Read once, they are plain fields.
//
// Not here: modules that take an `env` parameter (HERMES_HOME's paths, GitHub tokens, the command a
// sidebar runs) keep it, so tests hand them their own.

import { type HermesCommand, readHermesCommand } from '../hermes/connect.js'
import { parseJson } from '../wire/json.js'

/** What the launcher said at startup. Every string is '' when its variable is unset. */
export interface LaunchEnv {
  /** HERMES_TERN_HERMES: how to run this Hermes (the gateway attach, a sidebar); undefined outside `hermes tern`. */
  readonly hermes: HermesCommand | undefined
  /** HERMES_TERN_CREATE: the launch flags as `session.create` fields (model, provider, skills, yolo, …). */
  readonly create: Readonly<Record<string, unknown>>
  /** HERMES_TERN_TOOL_PROGRESS: `-v` / `-Q`, pinned on each new session ('' for the profile's). */
  readonly toolProgress: string
  /** HERMES_TERN_RESUME, trimmed: the session to resume first ('' starts a new one). */
  readonly resume: string
  /** HERMES_TERN_QUERY, trimmed: `hermes tern -q …`, the first prompt. */
  readonly query: string
  /** HERMES_TERN_IMAGE, trimmed: `--image`, attached to the first session. */
  readonly image: string
  /** HERMES_TERN_SESSION_CWD, trimmed: the folder new sessions start in ('' lets the gateway choose). */
  readonly sessionCwd: string
  /** HERMES_TERN_CWD, else the process's folder: where the user launched Hermes, for relative paths. */
  readonly cwd: string
  /** HOME as set: undefined when unset, kept as given otherwise. */
  readonly home: string | undefined
  /** HERMES_TERN_EVENT_LOG: the development tap's file ('' for none). */
  readonly eventLog: string
  /** TERN_PANE: the Tern pane this runs in, whose conversation the plugin keeps ('' outside Tern). */
  readonly pane: string
  /** HERMES_TERN_LAUNCH_CWD, else `cwd`: where `hermes tern` started, before a resume moved to the session's folder. */
  readonly paneCwd: string
  /** HERMES_TERN_RESTORED set: the launcher resumes the pane's conversation after its program died. */
  readonly restored: boolean
}

/**
 * Parses `env` (the process's by default); `cwd` stands in when HERMES_TERN_CWD is unset or empty.
 * Bracket reads: the environment is an index signature, and each name here is a launcher's.
 */
export function readLaunchEnv(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): LaunchEnv {
  const launchCwd = env['HERMES_TERN_CWD'] || cwd

  return Object.freeze({
    create: Object.freeze(createOptions(env['HERMES_TERN_CREATE'])),
    cwd: launchCwd,
    eventLog: env['HERMES_TERN_EVENT_LOG'] ?? '',
    hermes: readHermesCommand(env['HERMES_TERN_HERMES']),
    home: env['HOME'],
    image: env['HERMES_TERN_IMAGE']?.trim() ?? '',
    pane: env['TERN_PANE']?.trim() ?? '',
    paneCwd: env['HERMES_TERN_LAUNCH_CWD'] || launchCwd,
    query: env['HERMES_TERN_QUERY']?.trim() ?? '',
    restored: Boolean(env['HERMES_TERN_RESTORED']?.trim()),
    resume: env['HERMES_TERN_RESUME']?.trim() ?? '',
    sessionCwd: env['HERMES_TERN_SESSION_CWD']?.trim() ?? '',
    toolProgress: env['HERMES_TERN_TOOL_PROGRESS']?.trim() ?? ''
  })
}

/** The JSON object `raw` holds; {} for anything else. */
function createOptions(raw: string | undefined): Record<string, unknown> {
  const value = raw ? parseJson(raw) : undefined

  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {}
}

let launch: LaunchEnv | undefined

/**
 * This process's LaunchEnv, parsed on first use and the same object after. entry.ts reads it at
 * startup; view helpers with no host to ask (a path shortened for a label) read it here.
 */
export function launchEnv(): LaunchEnv {
  return (launch ??= readLaunchEnv())
}
