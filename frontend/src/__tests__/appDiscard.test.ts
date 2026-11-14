// App tests: a turn whose outcome is unknown (the gateway died while it ran) blocks the gateway's
// queue until someone discards it. Its row offers Discard, which sends prompt.resolve_unknown.
import { type Node } from '@stencil-hq/tern'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { busy, settle, setup } from './appSetup.js'
import { given, key, must, topNodes } from './fakes.js'

vi.mock('@hermes/shared/prompt-history', () => ({ append: () => undefined, load: () => [] }))

beforeEach(() => {
  delete process.env['HERMES_TERN_QUERY']
  delete process.env['HERMES_TERN_IMAGE']
})

const lost = { admission_id: 'u1', execution_generation: 3, input_id: 'in-u1', status: 'unknown', user: 'slow' }
const waiting = { admission_id: 'q1', execution_generation: null, input_id: 'in-q1', status: 'queued', user: 'after it' }

/** Clicks the action `role` on queued row `index` of the dock as last drawn. */
function clickQueued(region: ReturnType<ReturnType<typeof setup>['tern']['region']>, index: number, role: string) {
  const rows = topNodes(region).find(n => n.props['role'] === 'omp.queue')?.children ?? []
  const button = rows[index]?.children.find((c: Node) => c.props['role'] === role)
  expect(button, `${role} on row ${index}`).toBeDefined()
  void button?.handlers?.onClick?.({ act: 'click', ev: 'action', id: role, raw: {}, sf: 'hermes' })
}

describe('App: discard a turn whose outcome is unknown', () => {
  it('an unknown row offers Discard, and the queued row behind it offers nothing new', async () => {
    const { app, emit, queuedRows } = setup()
    given.busy(app.stores, { ...busy })
    emit('event', { payload: { pending_submissions: [lost, waiting] }, session_id: 's1', type: 'session.info' })
    await settle()

    expect(queuedRows()).toEqual([
      { actions: ['discard'], text: 'slow' },
      { actions: [], text: 'after it' }
    ])
  })

  it('Discard sends prompt.resolve_unknown with the session, the admission and its generation', async () => {
    const { emit, queuedRows, sent, tern } = setup({ 'prompt.resolve_unknown': () => ({ admission_id: 'u1', outcome: 'interrupted', status: 'terminal' }) })
    emit('event', { payload: { pending_submissions: [lost, waiting] }, session_id: 's1', type: 'session.info' })
    await settle()

    clickQueued(tern.region('dock'), 0, 'omp.queue.discard')
    await vi.waitFor(() => expect(sent('prompt.resolve_unknown')).toHaveLength(1))
    expect(sent('prompt.resolve_unknown')).toEqual([{ admission_id: 'u1', execution_generation: 3, session_id: 's1' }])
    expect(sent('prompt.cancel')).toEqual([])

    // The gateway's next pending list drops the row; the queued prompt runs.
    emit('event', { payload: { pending_submissions: [{ ...waiting, status: 'started' }] }, session_id: 's1', type: 'session.info' })
    await settle()
    expect(queuedRows()).toEqual([])
  })

  it("a refusal shows the gateway's message and leaves the row", async () => {
    const { app, emit, queuedRows, sent, tern } = setup({
      'prompt.resolve_unknown': () => {
        throw new Error('stale_generation')
      }
    })
    emit('event', { payload: { pending_submissions: [lost, waiting] }, session_id: 's1', type: 'session.info' })
    await settle()

    clickQueued(tern.region('dock'), 0, 'omp.queue.discard')
    await vi.waitFor(() => expect(sent('prompt.resolve_unknown')).toHaveLength(1))
    await settle()

    expect(JSON.stringify(app.transcript.entries)).toContain('stale_generation')
    expect(queuedRows()).toEqual([
      { actions: ['discard'], text: 'slow' },
      { actions: [], text: 'after it' }
    ])
  })

  it("this pane's queued prompt behind the unknown turn keeps Edit, which still sends prompt.cancel", async () => {
    const { app, emit, press, queuedRows, sent, tern, type } = setup({
      'prompt.cancel': () => ({ status: 'terminal' }),
      'prompt.submit': () => ({ admission_id: 'a1', status: 'queued' })
    })
    given.busy(app.stores, { ...busy })
    await type('fix me')
    await press(key('enter'))
    const mine = { admission_id: 'a1', input_id: must(sent('prompt.submit')[0])['submission_id'], status: 'queued', user: 'fix me' }
    emit('event', { payload: { pending_submissions: [lost, mine] }, session_id: 's1', type: 'session.info' })
    await settle()
    expect(queuedRows()).toEqual([
      { actions: ['discard'], text: 'slow' },
      { actions: ['steer', 'edit'], text: 'fix me' }
    ])

    clickQueued(tern.region('dock'), 1, 'omp.queue.edit')
    await vi.waitFor(() => expect(app.stores.composer.text).toBe('fix me'))
    expect(sent('prompt.cancel')).toEqual([{ admission_id: 'a1', session_id: 's1' }])
    expect(sent('prompt.resolve_unknown')).toEqual([])
  })
})
