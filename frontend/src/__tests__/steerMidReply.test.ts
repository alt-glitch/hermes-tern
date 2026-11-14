// App tests: a correction sent while the reply streams. A `/steer` does not stop the model call,
// so the rest of the reply keeps the same `turn_id` and `segment`, and its `offset` goes on from
// where it was. A redirect stops the model call, and the next call's text starts a new reply,
// although Hermes keeps counting the same offset. The frames below have the shape recorded from a
// live gateway with the lab's `stream…` prompt (Hermes main ffdc7eeb25).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TurnEntry } from '../model.js'
import { parts } from '../view/workLogModel.js'

import { type App, busy, settle, setup } from './appSetup.js'
import { given, key, must, type Reply } from './fakes.js'

vi.mock('@hermes/shared/prompt-history', () => ({ append: () => undefined, load: () => [] }))

beforeEach(() => {
  delete process.env['HERMES_TERN_QUERY']
  delete process.env['HERMES_TERN_IMAGE']
})

afterEach(() => {
  vi.useRealTimers()
})

const session = (mode: string): Record<string, Reply> => ({
  'config.get': p => (p['key'] === 'busy' ? { key: 'busy', value: mode } : {}),
  'session.create': () => ({ info: {}, session_id: 's1', subscription_id: 'sub1' }),
  'session.redirect': () => ({ status: 'redirected' }),
  'session.resume': () => ({ execution_generation: 7 }),
  'session.steer': () => ({ status: 'queued' }),
  'setup.status': () => ({ provider_configured: true })
})

/** The finished turn as it reads: each fold by its block kinds, each shown block by its text. */
const shown = (t: TurnEntry) =>
  parts(t).map(p => (p.kind === 'fold' ? `fold: ${p.blocks.map(b => b.kind).join()}` : p.blocks.map(b => (b.kind === 'text' ? b.text : b.kind)).join(' | ')))

async function started(mode: string) {
  const s = setup(session(mode))
  s.emit('event', { payload: {}, type: 'gateway.ready' })
  await vi.waitFor(() => expect(s.sent('config.get')).toContainEqual({ key: 'busy', session_id: 's1' }))
  await settle()
  given.busy(s.app.stores, { ...busy })

  const event = (type: string, payload: Record<string, unknown> = {}) => s.emit('event', { payload, session_id: 's1', type })
  let offset = 0

  /** One streamed chunk of reply `turn`, stamped as Hermes stamps it; `offset` counts on unless `from` resets it. */
  const delta = (text: string, turn: string, from = offset) => {
    event('message.delta', { offset: from, segment: 0, text, turn_id: turn })
    offset = from + text.length
  }

  const tool = (id: string) => {
    event('tool.start', { args: { command: 'ls' }, name: 'terminal', tool_id: id })
    event('tool.complete', { name: 'terminal', result: '{"output": ""}', tool_id: id })
  }

  event('message.start')
  tool('look')

  return { ...s, delta, event, tool }
}

const lastTurn = (app: InstanceType<typeof App>) => must(app.transcript.entries.findLast((e): e is TurnEntry => e.kind === 'turn'))

describe('a correction sent while the reply streams', () => {
  it('/steer: the reply stays one text, in view, with the steer after it; the next model call is its own reply', async () => {
    const { app, delta, event, press, sent, tool, type } = await started('queue')
    delta('Agreed: keep the login code', 'run1')

    await type('/steer now do the steps')
    await press(key('enter'))
    await vi.waitFor(() => expect(sent('session.steer')).toHaveLength(1))

    // The same model call goes on: same turn_id and segment, the offset goes on.
    delta(' untouched. The handoff step listens for it.', 'run1')
    // Hermes takes the steer in a new run of the agent: new turn_id, offset 0.
    tool('s0')
    delta('All four steps ran.', 'run2', 0)
    event('message.complete', { text: 'All four steps ran.' })
    await settle()

    expect(shown(lastTurn(app))).toEqual([
      'fold: tool',
      'Agreed: keep the login code untouched. The handoff step listens for it. | steer',
      'fold: tool',
      'All four steps ran.'
    ])
  })

  it('redirect: the reply it cut stays as it was, and the text after it is a new reply', async () => {
    const { app, delta, event, press, sent, type } = await started('interrupt')
    delta('Agreed: keep the login code', 'run1')

    await type('only claim when we know')
    await press(key('enter'))
    await vi.waitFor(() => expect(sent('session.redirect')).toHaveLength(1))

    // The model call after the redirect keeps the turn_id, the segment and the running offset.
    delta('Agreed. Only claim when a guest exists.', 'run1')
    event('message.complete', { text: 'Agreed. Only claim when a guest exists.' })
    await settle()

    expect(shown(lastTurn(app))).toEqual(['fold: tool', 'Agreed: keep the login code | steer | Agreed. Only claim when a guest exists.'])
  })
})
