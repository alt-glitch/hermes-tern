// Where the Hermes profile keeps its files.

import { homedir } from 'node:os'
import { join } from 'node:path'

/** The profile's session store: `<HERMES_HOME>/state.db`, `~/.hermes` when HERMES_HOME is unset. */
export function stateDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env['HERMES_HOME'] || join(homedir(), '.hermes'), 'state.db')
}
