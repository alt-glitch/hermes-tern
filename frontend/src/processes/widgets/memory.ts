// Each process's chart rules on disk (`plugin-data/hermes-tern/charts/<id>.json`): a process
// outlives the pane that charted it, so a pane opened later, or a second pane on the session,
// reads the rules instead of asking the model again. A decline is kept too.

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { dataDir } from '../../connections.js'

import { type Spec, validateSpec } from './spec.js'

/** What is known of a process's chart: its rules, or that the model declined. */
export type Remembered = Spec | 'skip'

export interface ChartMemory {
  load(id: string): Remembered | undefined
  save(id: string, value: Remembered): void
}

/** Rules older than this go when a new one is saved: process ids are not reused, so they only take room. */
const KEEP_MS = 7 * 24 * 3600_000

const safe = (id: string) => /^[\w.-]{1,128}$/.test(id)

export function chartMemory(dir = join(dataDir(), 'charts'), now = Date.now): ChartMemory {
  return {
    load(id) {
      if (!safe(id)) {
        return undefined
      }

      try {
        const value: unknown = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'))

        if (value === 'skip') {
          return 'skip'
        }

        // Checked again: the file is outside the frontend's hands.
        const checked = validateSpec(value)

        return checked.ok ? checked.spec : undefined
      } catch {
        return undefined
      }
    },

    save(id, value) {
      if (!safe(id)) {
        return
      }

      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `${id}.json`), JSON.stringify(value))

        for (const name of readdirSync(dir)) {
          const file = join(dir, name)

          if (now() - statSync(file).mtimeMs > KEEP_MS) {
            rmSync(file, { force: true })
          }
        }
      } catch {
        // A chart without memory still draws; the next pane asks again.
      }
    }
  }
}
