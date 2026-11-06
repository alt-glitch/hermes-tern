// The bundled frontend loads the pinned, package-local card validator as data-only code.
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { record } from './json.js'

export interface CardDocument {
  readonly kind: string
  readonly app: string
  readonly title?: string
  readonly actions?: 'read-only' | 'host-confirmed'
  readonly fields?: Readonly<Record<string, string>>
  readonly buttons?: readonly (string | { readonly label: string; readonly action?: string })[]
  readonly [key: string]: unknown
}

export interface CardEnvelope {
  readonly id: string
  readonly card: CardDocument
}

export interface CardContract {
  validateCardDocument(input: unknown): CardDocument
  validatePreparedCard(input: unknown, scope: string): CardEnvelope
}

function isCardContract(value: unknown): value is CardContract {
  const module = record(value)

  return Boolean(
    module &&
      typeof module['validateCardDocument'] === 'function' &&
      typeof module['validatePreparedCard'] === 'function'
  )
}

function packagedCardUrl(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = basename(here) === 'wire' && basename(dirname(here)) === 'src'
  const frontend = source ? resolve(here, '../..') : resolve(here, '..')

  return pathToFileURL(join(frontend, 'openui/card.mjs')).href
}

export async function openCardContract(): Promise<CardContract> {
  let loaded: unknown

  try {
    loaded = await import(/* @vite-ignore */ packagedCardUrl())
  } catch {
    throw new Error('Pinned ephemeral-ui card schema or validator is missing or has changed.')
  }

  if (!isCardContract(loaded)) {
    throw new Error('Unsupported packaged ephemeral-ui card validator.')
  }

  return loaded
}
