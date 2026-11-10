// The terminal tool's detail: the unchanged command, how it ran, and what it printed.

import type { ToolCall } from '../model.js'

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
  /** Exact pinned foreground recreation signal; it does not prove which state survived. */
  environmentRecreated: boolean
  /** Exact pinned masked-success advisory; it does not establish an upstream exit code. */
  maskedSuccess: boolean
  /** Exact pinned historical report that async process notifications were unavailable. */
  asyncNotifyUnavailable: boolean
}

// Pinned Hermes emits this exact fixed text, not a boolean or arbitrary warning.
const RECREATED_SIGNAL = 'The execution environment was recreated while running this command ' +
  '(the previous container/sandbox was gone). Persistent files were restored ' +
  'where the backend supports it, but background processes and any files ' +
  'outside persisted paths from earlier commands may be lost — verify state ' +
  'before relying on prior work.'

// Pinned terminal_hints emits these exact strings for two distinct masked-success shapes.
const MASKED_PIPE = 'exit_code 0 here is the status of the last pipeline command (tail/head/cat/...), NOT of ' +
  'the command before the pipe — and the output contains failure indicators. Treat this run ' +
  'as FAILED until proven otherwise: re-run the command WITHOUT the pipe (output is ' +
  'auto-truncated and the full text is saved to a file, so piping through tail/head is never ' +
  'needed) to get the real exit code.'
const MASKED_FALLBACK = 'exit_code 0 here is the status of the `||` fallback (echo/true), NOT of the command before ' +
  'it — and the output contains failure indicators. Treat this run as FAILED until proven ' +
  'otherwise: re-run the command bare to get its real exit code.'

// The background producer emits this fixed message when the session cannot route async notices.
const ASYNC_UNSUPPORTED = 'notify_on_complete / watch_patterns are not available in this session — it cannot receive ' +
  'an async completion after the turn ends (a one-shot runner such as `hermes -z`, a cron ' +
  'job, a Kanban worker, or a stateless HTTP endpoint). The process is running in the ' +
  "background; retrieve its result with process(action='poll') or process(action='wait')."
const ASYNC_UNSUPPORTED_CURRENT = 'notify_on_complete / watch_patterns are not available in this session — it cannot receive ' +
  'an async completion after the turn ends (a one-shot runner such as `hermes -z`, a /bg ' +
  'background task, a cron job, a Kanban worker, or a stateless HTTP endpoint). The process is running in the ' +
  "background; retrieve its result with process(action='poll') or process(action='wait')."

function asyncNotifyUnavailable(result: Raw['result']): boolean {
  try {
    if (!result || !Object.hasOwn(result, 'notify_unsupported') ||
      (result['notify_unsupported'] !== ASYNC_UNSUPPORTED && result['notify_unsupported'] !== ASYNC_UNSUPPORTED_CURRENT)) return false
    if (!Object.hasOwn(result, 'notify_on_complete') || result['notify_on_complete'] !== false) return false
    if (!Object.hasOwn(result, 'session_id') || typeof result['session_id'] !== 'string' || !result['session_id']) return false
    if (!Object.hasOwn(result, 'output') || result['output'] !== 'Background process started') return false
    if (!Object.hasOwn(result, 'exit_code') || result['exit_code'] !== 0 || !Object.hasOwn(result, 'error') || result['error'] !== null) return false
    if (['status', 'success', 'is_error', 'failed', 'cancelled', 'watch_patterns', 'heartbeat_seconds'].some(key => key in result)) return false
    return true
  } catch {
    return false
  }
}

function maskedSuccess(args: Raw['args'], result: Raw['result']): boolean {
  if (!result || !Object.hasOwn(result, 'hint') || (result['hint'] !== MASKED_PIPE && result['hint'] !== MASKED_FALLBACK)) return false
  // The pinned foreground envelope has no background session or alternate outcome flags.
  if ('background' in args && (!Object.hasOwn(args, 'background') || args['background'] !== false)) return false
  if ('session_id' in result && (!Object.hasOwn(result, 'session_id') || result['session_id'] !== null)) return false
  if (['status', 'success', 'is_error', 'failed', 'cancelled'].some(key => key in result)) return false
  return Object.hasOwn(result, 'output') && typeof result['output'] === 'string' && Boolean(result['output']) &&
    Object.hasOwn(result, 'exit_code') && result['exit_code'] === 0 &&
    Object.hasOwn(result, 'error') && result['error'] === null
}

function recreation(result: Raw['result']): boolean {
  if (!result || !Object.hasOwn(result, 'environment_recreated') || result['environment_recreated'] !== RECREATED_SIGNAL) return false
  return Object.hasOwn(result, 'output') && typeof result['output'] === 'string' &&
    Object.hasOwn(result, 'exit_code') && typeof result['exit_code'] === 'number' && Number.isSafeInteger(result['exit_code']) &&
    Object.hasOwn(result, 'error') && result['error'] === null
}

export function terminalDetail({ args, result }: Raw): TerminalDetail {
  return {
    asyncNotifyUnavailable: asyncNotifyUnavailable(result),
    background: args['background'] === true || typeof result?.['session_id'] === 'string',
    command: text(args['command']),
    error: text(result?.['error']),
    environmentRecreated: recreation(result),
    exit: num(result?.['exit_code']),
    maskedSuccess: maskedSuccess(args, result),
    output: text(result?.['output']),
    tool: 'terminal'
  }
}

/** A retained background report describes past notification capability, not process outcome. */
export function terminalAsyncNotifyNeedsAttention(call: ToolCall, detail: TerminalDetail): boolean {
  return call.outcome.kind === 'done' && detail.background && detail.asyncNotifyUnavailable
}

/** A settled, foreground warning can be promoted without changing the call outcome. */
export function terminalRecreationNeedsAttention(call: ToolCall, detail: TerminalDetail): boolean {
  return call.outcome.kind !== 'running' && !detail.background && detail.environmentRecreated
}

/** A retained successful foreground advisory warns about another command's unknown outcome. */
export function terminalMaskedNeedsAttention(call: ToolCall, detail: TerminalDetail): boolean {
  return call.outcome.kind === 'done' && !detail.background && detail.maskedSuccess
}
