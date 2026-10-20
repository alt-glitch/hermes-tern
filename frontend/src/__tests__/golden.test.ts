// Golden replays: a recorded gateway stream (fixtures/*.jsonl, as the HERMES_TERN_EVENT_LOG tap writes
// it) fed through App on the fakes, between scripted keys (replays.ts). The frame after each step, the
// requests the app sent and its answers to server requests are file snapshots (__snapshots__/golden/),
// so a change to what the pane draws or sends shows up here as a diff.
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { must } from './fakes.js'
import { fixture, logLines, replay, replays } from './replays.js'

const ids = vi.hoisted(() => ({ n: 0 }))

vi.mock('node:crypto', async importOriginal => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomUUID: () => `00000000-0000-4000-8000-${String(++ids.n).padStart(12, '0')}`
}))
vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))
vi.mock('../hermes/sessionIndex.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../hermes/sessionIndex.js')>()),
  lastReply: () => '',
  storedSessions: () => []
}))

const home = mkdtempSync(join(tmpdir(), 'hermes-tern-golden-'))
process.env['HERMES_HOME'] = home

/** `text` with this machine's paths replaced, so the snapshot reads the same anywhere. */
function scrub(text: string): string {
  const paths: [string, string][] = [
    [home, '<HERMES_HOME>'],
    [process.cwd(), '<CWD>'],
    [homedir(), '<HOME>']
  ]

  return paths.reduce((out, [path, name]) => out.split(path).join(name), text)
}

/** `locales` with the machine's default (none named) as en-US. */
const localeOf = (locales: Intl.LocalesArgument): Intl.LocalesArgument =>
  locales === undefined || (Array.isArray(locales) && locales.length === 0) ? 'en-US' : locales

const dateString = Date.prototype.toLocaleString
const timeString = Date.prototype.toLocaleTimeString
const numberString = Number.prototype.toLocaleString

/** Times as en-US in UTC and numbers as en-US, whatever this machine's locale and zone. */
function pinLocale() {
  vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(function (this: Date, locales, options) {
    return dateString.call(this, localeOf(locales), { timeZone: 'UTC', ...options })
  })
  vi.spyOn(Date.prototype, 'toLocaleTimeString').mockImplementation(function (this: Date, locales, options) {
    return timeString.call(this, localeOf(locales), { timeZone: 'UTC', ...options })
  })
  vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (this: number, locales, options) {
    return numberString.call(this, localeOf(locales), options)
  })
}

beforeEach(() => {
  ids.n = 0
  vi.spyOn(Math, 'random').mockReturnValue(0)
  pinLocale()
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  // Time stands still: elapsed times, spinners and pollers draw the same on every run.
  vi.useFakeTimers({ now: new Date('2026-01-02T03:04:05Z'), toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('golden replays', () => {
  for (const [name, r] of Object.entries(replays)) {
    it(name, async () => {
      await expect(scrub(JSON.stringify(await replay(r), null, 1))).toMatchFileSnapshot(`__snapshots__/golden/${r.fixture}.json`)
    })
  }

  it('read what the HERMES_TERN_EVENT_LOG tap writes, events and server requests alike', async () => {
    const log = join(home, 'events.jsonl')
    process.env['HERMES_TERN_EVENT_LOG'] = log

    try {
      await replay(must(replays['an approval and a clarify question']))
    } finally {
      delete process.env['HERMES_TERN_EVENT_LOG']
    }

    expect(logLines(log)).toEqual(fixture('approval-clarify'))
  })
})
