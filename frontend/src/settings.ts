// This frontend's own settings: one JSON file in the profile's Hermes home
// (`<home>/hermes-tern/settings.json`), so the plugin needs neither config.yaml keys
// nor environment variables of its own. A missing or unreadable file is the defaults.

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { readSettings, readStoredSettings, settingsOf } from './wire/files.js'

/** Whose colors the surface wears: Tern's theme, the Nous palette, or the Hermes skin. */
export type ThemeMode = 'tern' | 'nous' | 'skin'

export interface Settings {
  theme?: ThemeMode | undefined
  /** Ask the gateway for each session's reasoning, shown as thought rows (default on). */
  thoughts?: boolean | undefined
  /** Live charts of background processes, their rules written by Hermes' auxiliary model once per process (default on). */
  jobCharts?: boolean | undefined
}

export function settingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HERMES_HOME || join(homedir(), '.hermes'), 'hermes-tern', 'settings.json')
}

/** The settings in `file`; a setting it does not hold, or holds as the wrong type, is unset (its default). */
export function loadSettings(file = settingsFile()): Settings {
  return readSettings(file)
}

/** Merges `patch` into the file, keeping the keys this version does not know; returns the merged settings. */
export function saveSettings(patch: Settings, file = settingsFile()): Settings {
  const next = { ...readStoredSettings(file), ...patch }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)

  return settingsOf(next)
}

/**
 * Where the panes keep their settings. The panes of one profile share the file, so a read sees
 * what another pane saved: read again where the moment matters (a session's thoughts flag).
 */
export interface SettingsSource {
  /** The settings now; the defaults when there are none. */
  load(): Settings
  /** Merges `patch` into the stored settings; returns the merged settings. */
  save(patch: Settings): Settings
}

/** The settings file: `file` when given, else the profile's, resolved at each read and write. */
export function fileSettings(file?: string): SettingsSource {
  return {
    load: () => loadSettings(file ?? settingsFile()),
    save: patch => saveSettings(patch, file ?? settingsFile())
  }
}
