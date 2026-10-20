// Golden replays: a recorded gateway stream (fixtures/*.jsonl, as the HERMES_TERN_EVENT_LOG tap writes
// it) fed through App on the fakes, between scripted keys. The frame after each step, the requests
// the app sent and its answers to server requests are file snapshots (__snapshots__/golden/), so a
// change to what the pane draws or sends shows up here as a diff.
import { mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Key } from '@stencil-hq/tern'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeGateway, fakeTern, key, type Reply, settle } from './fakes.js'

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
process.env.HERMES_HOME = home

const { App } = await import('../app.js')

/** One scripted step: type text, press a key, or feed the next `feed` lines of the fixture. */
type Step = { type: string } | { press: string; mods?: Partial<Key> } | { feed: number }

interface Replay {
  /** The fixture's name under fixtures/ (no extension). */
  fixture: string
  replies: Record<string, Reply>
  steps: Step[]
}

/** The session the gateway starts on ready. */
const started: Record<string, Reply> = {
  'session.create': () => ({ info: { stored_session_id: 's1' }, session_id: 's1', subscription_id: 'sub1' }),
  'session.resume': p => ({ execution_generation: 1, info: { stored_session_id: p.session_id }, revision: 1, session_id: p.session_id }),
  'setup.status': () => ({ provider_configured: true })
}

const replays: Record<string, Replay> = {
  'a turn with tool calls': {
    fixture: 'turn-tools',
    replies: started,
    steps: [{ feed: 1 }, { type: 'list the files' }, { press: 'enter' }, { feed: 3 }, { feed: 2 }, { feed: 2 }, { feed: 3 }]
  },

  'a prompt queued behind the turn, steered, and one that starts after it': {
    fixture: 'queue-steer',
    replies: {
      ...started,
      'prompt.cancel': () => ({ admission_id: 'a1', outcome: 'cancelled', status: 'terminal' }),
      'prompt.submit': p => (p.queued ? { admission_id: p.text === 'use tabs' ? 'a1' : 'a2', status: 'queued' } : { status: 'started' }),
      'session.steer': () => ({ status: 'queued' })
    },
    steps: [
      { feed: 1 },
      { type: 'format the code' },
      { press: 'enter' },
      { feed: 2 },
      { type: 'use tabs' },
      { press: 'enter' },
      { feed: 1 },
      { press: 'enter', mods: { alt: true } },
      { feed: 2 },
      { type: 'then the docs' },
      { press: 'enter' },
      { feed: 1 },
      { feed: 3 },
      { feed: 1 }
    ]
  },

  '/compress, then a resume': {
    fixture: 'compress-resume',
    replies: {
      ...started,
      'session.mutate': () => ({ after_tokens: 9000, before_tokens: 40000, status: 'applied', summary: { headline: 'Compressed 12 → 4 messages' } }),
      'session.resume': p =>
        p.session_id === 'old'
          ? {
              execution_generation: 1,
              info: { stored_session_id: 'old', title: 'Old chat' },
              messages: [
                { content: 'what changed?', role: 'user' },
                { content: 'Nothing yet.', role: 'assistant' }
              ],
              session_id: 'old',
              subscription_id: 'sub-old'
            }
          : { execution_generation: 1, info: { stored_session_id: p.session_id }, revision: 1, session_id: p.session_id }
    },
    steps: [
      { feed: 1 },
      { type: '/compress' },
      { press: 'enter' },
      { type: 'keep going' },
      { press: 'enter' },
      { feed: 2 },
      { feed: 1 },
      { feed: 2 },
      { type: '/resume old' },
      { press: 'enter' },
      { feed: 1 }
    ]
  },

  'an approval and a clarify question': {
    fixture: 'approval-clarify',
    replies: {
      ...started,
      'approval.respond': () => ({ status: 'resolved' }),
      'clarify.respond': () => ({ status: 'resolved' })
    },
    steps: [
      { feed: 1 },
      { type: 'clean up' },
      { press: 'enter' },
      { feed: 3 },
      { press: 'y', mods: { text: 'y' } },
      { feed: 2 },
      { feed: 1 },
      { press: 'down' },
      { press: 'enter' },
      { feed: 1 },
      { feed: 1 },
      { press: 'n', mods: { text: 'n' } },
      { feed: 1 }
    ]
  }
}

/** An event log's lines: gateway events, and server requests as `{"request": …}`. */
function logLines(path: string | URL): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

/** The lines of fixture `name`. */
const fixture = (name: string) => logLines(new URL(`./fixtures/${name}.jsonl`, import.meta.url))

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

/** A short name for `step`, for the snapshot. */
function label(step: Step): string {
  return 'feed' in step ? `feed ${step.feed}` : 'type' in step ? `type ${step.type}` : `press ${step.mods?.alt ? 'alt+' : ''}${step.press}`
}

/** Runs one replay and returns everything it snapshots. */
async function replay({ fixture: name, replies, steps }: Replay) {
  const lines = fixture(name)
  const gw = new FakeGateway({ replies })
  const tern = fakeTern({ cols: 100, draws: true })
  const answers: unknown[] = []
  const app = new App(tern.session, gw.client, '1.0.0')
  void app.run()

  const press = async (k: Key) => {
    for (let turns = 0; !tern.reading; turns++) {
      expect(turns, 'the app never asked for its next input').toBeLessThan(1000)
      await new Promise(resolve => setImmediate(resolve))
    }

    tern.press(k)
    await settle(gw)
  }

  const feed = (line: Record<string, unknown>) => {
    const request = line.request as { id: string } | undefined

    if (!request) {
      gw.event(line)

      return
    }

    gw.emit('request', {
      ...request,
      fail: (code: number, message: string) => answers.push({ error: { code, message }, id: request.id }),
      respond: (result: unknown) => answers.push({ id: request.id, result })
    })
  }

  const frames: { frame: unknown; step: string }[] = []
  let next = 0

  await settle(gw)

  for (const step of steps) {
    if ('feed' in step) {
      for (const line of lines.slice(next, next + step.feed)) {
        feed(line)
        await settle(gw)
      }

      next += step.feed
    } else if ('type' in step) {
      for (const ch of step.type) {
        await press(key(ch, { text: ch }))
      }
    } else {
      await press(key(step.press, step.mods))
    }

    await settle(gw)
    frames.push({ frame: JSON.parse(JSON.stringify(tern.frame ?? null)), step: label(step) })
  }

  expect(next, 'every fixture line is fed').toBe(lines.length)

  return scrub(JSON.stringify({ answers, frames, requests: gw.calls }, null, 1))
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
      await expect(await replay(r)).toMatchFileSnapshot(`__snapshots__/golden/${r.fixture}.json`)
    })
  }

  it('read what the HERMES_TERN_EVENT_LOG tap writes, events and server requests alike', async () => {
    const log = join(home, 'events.jsonl')
    process.env.HERMES_TERN_EVENT_LOG = log

    try {
      await replay(replays['an approval and a clarify question']!)
    } finally {
      delete process.env.HERMES_TERN_EVENT_LOG
    }

    expect(logLines(log)).toEqual(fixture('approval-clarify'))
  })
})
