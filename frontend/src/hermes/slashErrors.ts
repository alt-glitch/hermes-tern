// What a refused slash command leads to, as Hermes' Ink TUI decides it (ui-tui/src/app/userMessages.ts):
// only "slash.exec does not own this command" (skills, bundles) falls through to command.dispatch;
// re-dispatching any other refusal could run a mutating command twice.
import { describeSlashExecError, isUnsupportedCommand, shouldFallbackToDispatch } from '@tui/app/userMessages.js'

import type { NoticeEntry } from '../model.js'

/** What a failed `slash.exec` of `/name` leads to: command.dispatch, or a notice that says why. */
export type ExecRefusal = { kind: 'dispatch' } | { kind: 'notice'; text: string; tone: NoticeEntry['tone'] }

/** What `slash.exec` failing with `error` for `/name` leads to. */
export function execRefusal(name: string, error: unknown): ExecRefusal {
  if (isUnsupportedCommand(error) || !shouldFallbackToDispatch(error)) {
    return { kind: 'notice', text: describeSlashExecError(name, error), tone: isUnsupportedCommand(error) ? 'warning' : 'error' }
  }

  return { kind: 'dispatch' }
}

/** Why `command.dispatch` of `/name` failed, for the user. */
export function dispatchError(name: string, error: unknown): string {
  return describeSlashExecError(name, error)
}
