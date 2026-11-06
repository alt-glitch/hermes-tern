// Where the gateway connection comes from: `hermes gateway attach --json`, run with the command the
// launcher hands the pane (HERMES_TERN_HERMES: this install's interpreter on its checkout), once per
// dial. `--start` ensures the profile's gateway on the first dial; `--recover` re-ensures one that is
// not ready when the client asks. Each run mints a new single-use ticket.
//
// The only module that knows how: when Hermes ships a library call for the attach step, it replaces
// the subprocess here.

import { execFile } from 'node:child_process'

import type { ConnectGateway, GatewayConnection } from '@hermes/shared/gateway-client'
import * as z from 'zod/mini'

import { parseJson } from '../wire/json.js'

/** How to run this Hermes: `argv` (the interpreter and `-m hermes_cli.main`), and what its environment adds. */
export interface HermesCommand {
  readonly argv: readonly [string, ...string[]]
  readonly env: Readonly<Record<string, string>>
}

const command = z.object({ argv: z.tuple([z.string()], z.string()), env: z.catch(z.record(z.string(), z.string()), {}) })

/** The command HERMES_TERN_HERMES names (JSON); undefined when it is unset or unreadable. */
export function readHermesCommand(raw: string | undefined): HermesCommand | undefined {
  return raw ? command.safeParse(parseJson(raw)).data : undefined
}

// `attach` exits with `ensure`'s codes; a start may take its 60 s deadline plus discovery and the ticket.
const ATTACH_TIMEOUT_MS = 90_000
/** Exit codes no retry fixes: an invalid invocation (an older Hermes without `attach`), an incompatible
 *  runtime, an authorization or profile mismatch. Any other failure is retried by the client. */
const TERMINAL_CODES = new Set([2, 3, 4])

const grant = z.object({
  endpoint: z.object({ instance_id: z.string(), profile_id: z.string() }),
  protocols: z.array(z.string()),
  url: z.string()
})
const verdict = z.object({ message: z.optional(z.string()) })

/** A failed attach: its verdict text, and whether a retry could help. */
export class AttachError extends Error {
  constructor(
    message: string,
    readonly terminal: boolean
  ) {
    super(message)
  }
}

/** What a run of the command gave: its exit code (0 on success) and its output. */
export interface Ran {
  code: number
  stdout: string
  stderr: string
}

export type Runner = (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<Ran>

const runFile: Runner = (file, args, env) =>
  new Promise(resolve => {
    execFile(file, args, { encoding: 'utf8', env, maxBuffer: 1024 * 1024, timeout: ATTACH_TIMEOUT_MS }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0

      resolve({ code, stderr: stderr || (error && !stdout ? error.message : ''), stdout })
    })
  })

/** The last line of `text` that is JSON. */
const lastJson = (text: string): unknown =>
  text
    .split('\n')
    .reverse()
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => parseJson(line))
    .find(value => value !== undefined)

/**
 * The client's `connect`: one `hermes gateway attach --json` per dial, mapped to the grant the client
 * dials. A refusal throws an {@link AttachError} carrying attach's own verdict (`gateway <state>: …`).
 */
export function attachGateway(hermes: HermesCommand, run: Runner = runFile, env: NodeJS.ProcessEnv = process.env): ConnectGateway {
  return async (start: boolean, recover: boolean): Promise<GatewayConnection> => {
    const [file, ...args] = hermes.argv
    const flags = start ? ['--start'] : recover ? ['--recover'] : []
    const ran = await run(file, [...args, 'gateway', 'attach', '--json', ...flags], { ...env, ...hermes.env })
    const reply = lastJson(ran.stdout)

    if (ran.code === 0) {
      const parsed = grant.safeParse(reply)

      if (parsed.success) {
        const { endpoint, protocols, url } = parsed.data

        return { instance_id: endpoint.instance_id, profile_id: endpoint.profile_id, protocols, url }
      }
    }

    const said = verdict.safeParse(reply).data?.message?.trim() || ran.stderr.trim() || `hermes gateway attach exited ${ran.code}`
    // An older Hermes knows no `attach` command: say what to do about it.
    const message = /'attach' is not a `hermes gateway` command|invalid choice: 'attach'/.test(said)
      ? 'gateway unavailable: this Hermes has no `hermes gateway attach`; run `hermes update`'
      : said

    throw new AttachError(message, TERMINAL_CODES.has(ran.code))
  }
}

/** For the client's `terminalConnectFailure`: the line to report when no retry can fix the attach. */
export function terminalAttachFailure(error: Error): string | undefined {
  return error instanceof AttachError && error.terminal ? (error.message.split('\n')[0] ?? error.message) : undefined
}
