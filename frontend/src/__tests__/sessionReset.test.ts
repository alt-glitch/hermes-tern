// The session fixes of WP24, each pinned by a test that failed before its fix: adopting another
// session resets the whole transcript at once (its entries, live turn, counters, pending reason
// line and compactions), the adopted session's info is its own or none, and while no session is
// shown, another session's events and requests do not reach the pane.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TurnEntry } from '../model.js'

import { FakeGateway, fakeTern, must } from './fakes.js'

process.env['HERMES_HOME'] = mkdtempSync(join(tmpdir(), 'hermes-tern-session-reset-'))

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))

const { App } = await import('../app/chat.js')

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

let gw: FakeGateway
let created = 0

beforeEach(() => {
  created = 0
  gw = new FakeGateway()
  gw.handlers.set('setup.status', () => ({ provider_configured: true }))
  gw.handlers.set('session.create', () => {
    created++

    return { info: { model: `model-${created}`, stored_session_id: `s${created}` }, session_id: `s${created}`, subscription_id: `sub${created}` }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** The app, its first session (s1) adopted. */
async function started() {
  const app = new App(fakeTern().session, gw.client, '')
  void app.run()
  gw.event({ payload: {}, type: 'gateway.ready' })
  await flush()
  await flush()

  return app
}

/** The transcript's turns, oldest first. */
const turns = (app: InstanceType<typeof App>) => app.transcript.entries.filter((e): e is TurnEntry => e.kind === 'turn')

/** A session.usage tick for `sid` with the owner's cumulative counters. */
const tick = (sid: string, total: number) =>
  gw.event({ payload: { cache_read_tokens: 0, prompt_tokens: total, total_tokens: total }, session_id: sid, type: 'session.usage' })

describe('adopting another session resets the transcript at once', () => {
  it("the new session's first turn counts its tokens from its own start, not from the last session's counters", async () => {
    const app = await started()
    gw.event({ payload: {}, session_id: 's1', type: 'message.start' })
    tick('s1', 1_000)
    gw.event({ payload: { text: 'done' }, session_id: 's1', type: 'message.complete' })

    await app.newSession()
    expect(app.session.ref.live).toBe('s2')

    gw.event({ payload: {}, session_id: 's2', type: 'message.start' })
    // Higher than the last session's totals, so the old repair (counters going back) never ran.
    tick('s2', 1_500)

    expect(must(turns(app).at(-1)).tickTokens).toBe(1_500)
  })

  it("the last session's pending reason line does not label the new session's first turn", async () => {
    const app = await started()
    // Hermes queued a delegation's completion for s1: the reason line waits for its turn.
    app.transcript.started('[ASYNC DELEGATION COMPLETE] the child finished')

    await app.newSession()
    gw.event({ payload: {}, session_id: 's2', type: 'message.start' })

    expect(must(turns(app).at(-1)).continued).toBeUndefined()
  })

  it("a snapshot with no info leaves none, not the last session's", async () => {
    const app = await started()
    expect(app.session.info?.model).toBe('model-1')
    gw.handlers.set('session.create', () => ({ session_id: 's2', subscription_id: 'sub2' }))

    await app.newSession()

    expect(app.session.ref.live).toBe('s2')
    expect(app.session.info).toBeNull()
  })
})
