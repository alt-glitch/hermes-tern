// The terminal tool's detail: the command, how it ran, and what it printed; and a command without
// the plugin's Tern pane prefix, as every view and store shows it.

import { num, type Raw, text } from './fields.js'

/** A `terminal` call, read once. */
export interface TerminalDetail {
  tool: 'terminal'
  /** The command, when the args name one (a view falls back to the call's context). */
  command: string | undefined
  /**
   * It started a background process: asked to (`background: true`), or moved there by Hermes (a
   * long timeout, a message arriving mid-run), whose result then names the process.
   */
  background: boolean
  output: string | undefined
  error: string | undefined
  /** The exit code, when the result has one. */
  exit: number | undefined
}

export function terminalDetail({ args, result }: Raw): TerminalDetail {
  return {
    background: args['background'] === true || typeof result?.['session_id'] === 'string',
    command: text(args['command']),
    error: text(result?.['error']),
    exit: num(result?.['exit_code']),
    output: text(result?.['output']),
    tool: 'terminal'
  }
}

/**
 * The prefix the plugin's `tool_request` middleware puts before a command so it runs with the chat's
 * Tern pane (`tern_env.py`): `export TERN_PANE=… …;` and/or `unset TERN_…;`. It is not what the agent
 * wrote, so the views and the stores leave it out.
 */
const TERN_ENV = /^\s*(?:export (?:TERN_[A-Z_]+=(?:'[^']*'|"[^"]*"|[^\s;]+) ?)+; ?)?(?:unset (?:TERN_[A-Z_]+ ?)+; ?)?/

/** `command` without the plugin's Tern pane prefix. */
export function withoutTernEnv(command: string): string {
  const m = TERN_ENV.exec(command)

  return m?.[0] ? command.slice(m[0].length) : command
}
