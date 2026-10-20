// The terminal tool's detail: the command, how it ran, and what it printed.

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
