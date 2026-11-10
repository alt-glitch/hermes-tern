// The plugin's own data folder, `<HERMES_HOME>/plugin-data/hermes-tern/`, as Hermes'
// `plugin_data_dir` names it for the Python half (plugin_data.py). The pane files and the chart
// memory live under it.

import { homedir } from 'node:os'
import { join } from 'node:path'

export const dataDir = (env: NodeJS.ProcessEnv = process.env) => join(env['HERMES_HOME'] || join(homedir(), '.hermes'), 'plugin-data', 'hermes-tern')
