// The golden replays' scripts: a recorded gateway stream (fixtures/*.jsonl, as the
// HERMES_TERN_EVENT_LOG tap writes it) fed through App on the fakes, between scripted keys.
// golden.test.ts snapshots what each one draws and sends; dispatch.test.ts checks what each
// event did to the pane.
import { readFileSync } from 'node:fs'

import type { Key, Node } from '@stencil-hq/tern'
import { expect } from 'vitest'

import { parseJson, record } from '../wire/json.js'

import { type Call, FakeGateway, fakeTern, key, must, type Reply, settle, topNodes } from './fakes.js'

/** One scripted step: type text, press a key, or feed the next `feed` lines of the fixture. */
export type Step = { type: string } | { press: string; mods?: Partial<Key> } | { feed: number } | { click: string }

export interface Replay {
  /** The fixture's name under fixtures/ (no extension). */
  fixture: string
  replies: Record<string, Reply>
  steps: Step[]
}

/** The session the gateway starts on ready. */
const started: Record<string, Reply> = {
  'session.create': () => ({ info: { stored_session_id: 's1' }, session_id: 's1', subscription_id: 'sub1' }),
  'session.resume': p => ({ execution_generation: 1, info: { stored_session_id: p['session_id'] }, revision: 1, session_id: p['session_id'] }),
  'setup.status': () => ({ provider_configured: true })
}

/** The replays, by name: each one's fixture, the gateway's answers and the scripted steps. */
export const replays: Record<string, Replay> = {
  'context usage, its snapshot, and a later usage tick': {
    fixture: 'context-meter',
    replies: {
      ...started,
      'session.context_breakdown': () => ({
        categories: [{ color: 'accent', id: 'conversation', label: 'Conversation', tokens: 250 }],
        context_estimated: true, context_max: 1000, context_percent: 25, context_source: 'estimate',
        context_used: 250, estimated_total: 250, model: 'fake-model'
      })
    },
    steps: [{ feed: 1 }, { feed: 1 }, { click: 'omp.composer.context.action' }, { press: 'escape' }, { feed: 1 }]
  },

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
      'prompt.submit': p => (p['queued'] ? { admission_id: p['text'] === 'use tabs' ? 'a1' : 'a2', status: 'queued' } : { status: 'started' }),
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
        p['session_id'] === 'old'
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
          : { execution_generation: 1, info: { stored_session_id: p['session_id'] }, revision: 1, session_id: p['session_id'] }
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
export function logLines(path: string | URL): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => record(line) ?? {})
}

/** The lines of fixture `name`. */
export const fixture = (name: string) => logLines(new URL(`./fixtures/${name}.jsonl`, import.meta.url))

/** A short name for `step`, for the snapshot. */
function label(step: Step): string {
  return 'feed' in step ? `feed ${step.feed}` : 'type' in step ? `type ${step.type}` : 'click' in step ? `click ${step.click}` : `press ${step.mods?.alt ? 'alt+' : ''}${step.press}`
}

/** What a replay leaves: its answers to server requests, the frame after each step, and the requests sent. */
export interface Played {
  answers: unknown[]
  frames: { frame: unknown; step: string }[]
  requests: Call[]
}

/**
 * Runs one replay through App on the fakes. The caller sets HERMES_HOME and mocks what it pins
 * (ids, the prompt history, the session index) before the first replay, which imports App.
 */
export async function replay({ fixture: name, replies, steps }: Replay): Promise<Played> {
  const { App } = await import('../app/chat.js')
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
    // The tap's note of an event type the pane did not know: the event itself is the line before.
    if ('unknown' in line) {
      return
    }

    const request = record(line['request'])

    if (!request) {
      gw.event(line)

      return
    }

    gw.emit('request', {
      ...request,
      fail: (code: number, message: string) => answers.push({ error: { code, message }, id: request['id'] }),
      respond: (result: unknown) => answers.push({ id: request['id'], result })
    })
  }

  const frames: Played['frames'] = []
  let next = 0

  await settle(gw)

  for (const step of steps) {
    if ('feed' in step) {
      for (const line of lines.slice(next, next + step.feed)) {
        feed(line)
        await settle(gw)
      }

      next += step.feed
    } else if ('click' in step) {
      const walk = (nodes: readonly Node[]): Node[] => nodes.flatMap(n => [n, ...walk(n.children)])
      const target = must(walk(topNodes(tern.region('dock'))).find(n => n.props['role'] === step.click))
      must(target.handlers?.onClick)({ act: 'click', ev: 'action', id: 'test', raw: {}, sf: 'hermes' })
    } else if ('type' in step) {
      for (const ch of step.type) {
        await press(key(ch, { text: ch }))
      }
    } else {
      await press(key(step.press, step.mods))
    }

    await settle(gw)
    frames.push({ frame: parseJson(JSON.stringify(tern.frame ?? null)), step: label(step) })
  }

  expect(next, 'every fixture line is fed').toBe(lines.length)

  return { answers, frames, requests: gw.calls }
}
