// App tests: Enter while a turn runs (busy_input_mode) and prompts around a compaction.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type App, busy, settle, setup } from './appSetup.js'
import { given, key, must, type Reply } from './fakes.js'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))

beforeEach(() => {
  delete process.env['HERMES_TUI_QUERY']
  delete process.env['HERMES_TUI_IMAGE']
})

afterEach(() => {
  vi.useRealTimers()
})

const session = (mode: string): Record<string, Reply> => ({
  'config.get': p => (p['key'] === 'busy' ? { key: 'busy', value: mode } : {}),
  'session.create': () => ({ info: {}, session_id: 's1', subscription_id: 'sub1' }),
  'session.resume': () => ({ execution_generation: 7 }),
  'setup.status': () => ({ provider_configured: true })
})

const users = (app: InstanceType<typeof App>) => app.transcript.entries.flatMap(e => (e.kind === 'user' ? [e.text] : []))

describe('App: compaction', () => {
  const status = (kind: string, text = '') => ({ payload: { kind, text }, session_id: 's1', type: 'status.update' })

  it('a prompt sent while /compress runs (no turn) waits in the queue, with no Steer, and shows in the dock', async () => {
    const { app, emit, press, queuedRows, sent, type } = setup({ 'prompt.submit': () => ({ admission_id: 'a1', status: 'queued' }) })
    emit('event', status('compressing', '⠋ compressing 12 messages (~40,000 tok)…'))
    await type('after it')
    await press(key('enter'))

    expect(sent('prompt.submit')).toMatchObject([{ queued: true, text: 'after it' }])
    expect(users(app)).toEqual([])
    expect(queuedRows()).toEqual([{ actions: ['edit'], text: 'after it' }])
    expect(JSON.stringify(app.transcript.entries)).toContain('"status":"running"')
  })

  it('on a private gateway the held prompt goes when the compaction ends', async () => {
    const { app, emit, press, sent, type } = setup({}, { canonical: false })
    emit('event', status('compressing', 'compressing'))
    await type('after it')
    await press(key('enter'))
    expect(sent('prompt.submit')).toEqual([])
    expect(app.stores.queue.held).toMatchObject([{ text: 'after it' }])

    emit('event', status('ready'))
    await settle()
    expect(sent('prompt.submit')).toMatchObject([{ text: 'after it' }])
  })

  it('a compaction inside a turn still offers Steer on a queued prompt (Hermes holds it until the compaction ends)', async () => {
    const { app, emit, press, queuedRows, type } = setup({ 'prompt.submit': () => ({ admission_id: 'a1', status: 'queued' }) })
    given.busy(app.stores, { ...busy })
    emit('event', { payload: {}, session_id: 's1', type: 'message.start' })
    emit('event', status('compacting', '🗜️ Compacting context — summarizing earlier conversation so I can continue...'))
    await settle()
    expect(app.stores.activity.busy?.label).toBe('Compacting context…')

    await type('look at the tests too')
    await press(key('enter'))
    expect(queuedRows()).toEqual([{ actions: ['steer', 'edit'], text: 'look at the tests too' }])
  })
})

describe('App: Enter while a turn runs (busy_input_mode)', () => {
  it('queue: admits the prompt to the gateway at once, shows it queued, and paints its bubble when it starts', async () => {
    const { app, attach, emit, press, queuedRows, sent, type } = setup({ 'prompt.submit': () => ({ admission_id: 'a1', status: 'queued' }) })
    given.busy(app.stores, { ...busy })
    await attach()
    await type('next one')
    await press(key('enter'))

    const [submit] = sent('prompt.submit')
    expect(submit).toMatchObject({ attachments: [{ path: '/uploads/1.png' }], queued: true, session_id: 's1', text: 'next one' })
    expect(app.stores.queue.held).toEqual([])
    expect(users(app)).toEqual([])
    expect(queuedRows()).toEqual([{ actions: ['edit'], note: 'has images: waits for this turn', text: 'next one ↵ 📎 1 image' }])

    const row = { admission_id: 'a1', input_id: must(submit)['submission_id'], status: 'queued', user: 'next one' }
    emit('event', { payload: { pending_submissions: [row] }, session_id: 's1', type: 'session.info' })
    emit('event', { payload: { text: 'first reply' }, session_id: 's1', type: 'message.complete' })
    emit('event', { payload: {}, session_id: 's1', type: 'message.start' })
    emit('event', { payload: { pending_submissions: [{ ...row, status: 'started' }] }, session_id: 's1', type: 'session.info' })
    await settle()

    // After the reply it waited for, before the turn it opened; and only once.
    expect(users(app)).toEqual(['next one'])
    expect(app.transcript.entries.findLast(e => e.kind === 'user')).toMatchObject({ attachments: [{ kind: 'image' }] })
    expect(app.transcript.entries.map(e => e.kind).slice(-2)).toEqual(['user', 'turn'])
    expect(queuedRows()).toEqual([])
  })

  it('a skill invoked while a turn runs is queued like a prompt: the queue and its bubble show the invocation, not the body', async () => {
    const body = '[IMPORTANT: The user has invoked the "fanout" skill…]\n\n…the skill body…'
    const { app, emit, press, queuedRows, sent, type } = setup({
      'prompt.submit': () => ({ admission_id: 'a1', status: 'queued' }),
      'slash.exec': () => ({ display: '/fanout if needed', message: body, name: 'fanout', type: 'skill' })
    })
    given.busy(app.stores, { ...busy })
    await type('/fanout if needed')
    await press(key('enter'))
    await settle()

    const [submit] = sent('prompt.submit')
    expect(submit).toMatchObject({ queued: true, text: body })
    expect(users(app)).toEqual([])
    expect(queuedRows()).toEqual([{ actions: ['steer', 'edit'], text: '/fanout if needed' }])

    const row = { admission_id: 'a1', input_id: must(submit)['submission_id'], status: 'queued', user: body }
    emit('event', { payload: { pending_submissions: [row] }, session_id: 's1', type: 'session.info' })
    emit('event', { payload: { text: 'first reply' }, session_id: 's1', type: 'message.complete' })
    emit('event', { payload: {}, session_id: 's1', type: 'message.start' })
    emit('event', { payload: { pending_submissions: [{ ...row, status: 'started' }] }, session_id: 's1', type: 'session.info' })
    await settle()

    expect(users(app)).toEqual(['/fanout if needed'])
    expect(app.transcript.entries.map(e => e.kind).slice(-2)).toEqual(['user', 'turn'])
  })

  it('a prompt sent while idle gets one bubble, even when the gateway reports it queued then started', async () => {
    const { app, emit, press, sent, type } = setup()
    await type('hello')
    await press(key('enter'))
    const row = { admission_id: 'a1', input_id: must(sent('prompt.submit')[0])['submission_id'], status: 'queued', user: 'hello' }

    emit('event', { payload: { pending_submissions: [row] }, session_id: 's1', type: 'session.info' })
    emit('event', { payload: { pending_submissions: [{ ...row, status: 'started' }] }, session_id: 's1', type: 'session.info' })
    await settle()

    expect(users(app)).toEqual(['hello'])
  })

  it("shows another window's queued prompt read-only, and its bubble when it starts", async () => {
    const { app, emit, queuedRows } = setup()
    given.busy(app.stores, { ...busy })
    const row = { admission_id: 'b1', input_id: 'theirs', status: 'queued', user: 'from desktop' }

    emit('event', { payload: { pending_submissions: [row] }, session_id: 's1', type: 'session.info' })
    await settle()
    expect(queuedRows()).toEqual([{ actions: [], text: 'from desktop' }])

    emit('event', { payload: { pending_submissions: [{ ...row, status: 'started' }] }, session_id: 's1', type: 'session.info' })
    await settle()
    expect(users(app)).toEqual(['from desktop'])
  })

  it("a queued row's Steer withdraws it from the gateway's queue and steers the turn; its cancelled completion does not end the turn", async () => {
    const { app, emit, press, queuedRows, sent, type } = setup({
      'prompt.cancel': () => ({ admission_id: 'a1', outcome: 'cancelled', status: 'terminal' }),
      'prompt.submit': () => ({ admission_id: 'a1', status: 'queued' }),
      'session.resume': () => ({ execution_generation: 7 }),
      'session.steer': () => ({ status: 'queued' })
    })
    given.busy(app.stores, { ...busy })
    app.transcript.messageStart()
    await type('use tabs')
    await press(key('enter'))
    const row = { admission_id: 'a1', input_id: must(sent('prompt.submit')[0])['submission_id'], status: 'queued', user: 'use tabs' }
    emit('event', { payload: { pending_submissions: [row] }, session_id: 's1', type: 'session.info' })
    await settle()
    expect(queuedRows()).toEqual([{ actions: ['steer', 'edit'], text: 'use tabs' }])

    await press(key('enter', { alt: true }))
    await vi.waitFor(() => expect(sent('session.steer')).toHaveLength(1))
    emit('event', { payload: { admission_id: 'a1', content: '', outcome: 'cancelled', text: '' }, session_id: 's1', type: 'message.complete' })
    emit('event', { payload: { pending_submissions: [] }, session_id: 's1', type: 'session.info' })
    await settle()

    expect(sent('prompt.cancel')).toEqual([{ admission_id: 'a1', session_id: 's1' }])
    expect(sent('session.steer')[0]).toMatchObject({ execution_generation: 7, session_id: 's1', text: 'use tabs' })
    expect(app.transcript.live?.blocks.map(b => b.kind)).toEqual(['steer'])
    expect(app.stores.activity.busy).not.toBeNull()
    expect(queuedRows()).toEqual([])
  })

  it("a queued row's Edit takes it out of the gateway's queue and back into the composer", async () => {
    const { app, emit, press, sent, type } = setup({
      'prompt.cancel': () => ({ status: 'terminal' }),
      'prompt.submit': () => ({ admission_id: 'a1', status: 'queued' })
    })
    given.busy(app.stores, { ...busy })
    await type('fix me')
    await press(key('enter'))
    const row = { admission_id: 'a1', input_id: must(sent('prompt.submit')[0])['submission_id'], status: 'queued', user: 'fix me' }
    emit('event', { payload: { pending_submissions: [row] }, session_id: 's1', type: 'session.info' })

    await press(key('up', { alt: true }))
    await vi.waitFor(() => expect(app.stores.composer.text).toBe('fix me'))
    expect(sent('prompt.cancel')).toHaveLength(1)
  })

  it('steer: injects the prompt into the turn; a refused steer is queued instead', async () => {
    let steer = { status: 'queued' }
    const { app, emit, press, sent, type } = setup({
      ...session('steer'),
      'prompt.submit': () => ({ admission_id: 'a1', status: 'queued' }),
      'session.steer': () => steer
    })
    emit('event', { payload: {}, type: 'gateway.ready' })
    await vi.waitFor(() => expect(sent('config.get')).toContainEqual({ key: 'busy', session_id: 's1' }))
    await settle()
    given.busy(app.stores, { ...busy })
    app.transcript.messageStart()

    await type('look at the tests too')
    await press(key('enter'))
    await vi.waitFor(() => expect(sent('session.steer')).toHaveLength(1))
    expect(sent('session.steer')[0]).toMatchObject({ execution_generation: 7, text: 'look at the tests too' })
    expect(app.transcript.live?.blocks.at(-1)).toMatchObject({ kind: 'steer', text: 'look at the tests too' })
    expect(sent('prompt.submit')).toEqual([])

    steer = { status: 'rejected' }
    await type('then this')
    await press(key('enter'))
    await vi.waitFor(() => expect(sent('prompt.submit')).toHaveLength(1))
    expect(sent('prompt.submit')[0]).toMatchObject({ queued: true, text: 'then this' })
  })

  it('interrupt: redirects the turn with the prompt (session.redirect)', async () => {
    const { app, emit, press, sent, type } = setup({ ...session('interrupt'), 'session.redirect': () => ({ status: 'redirected' }) })
    emit('event', { payload: {}, type: 'gateway.ready' })
    await vi.waitFor(() => expect(sent('config.get')).toContainEqual({ key: 'busy', session_id: 's1' }))
    await settle()
    given.busy(app.stores, { ...busy })

    await type('no, use rust')
    await press(key('enter'))
    await vi.waitFor(() => expect(sent('session.redirect')).toHaveLength(1))
    expect(sent('session.redirect')[0]).toEqual({ execution_generation: 7, session_id: 's1', text: 'no, use rust' })
    expect(sent('prompt.submit')).toEqual([])
  })

  it('/queue queues behind the turn whatever the mode says', async () => {
    const { app, emit, press, sent, type } = setup({ ...session('steer'), 'prompt.submit': () => ({ admission_id: 'a1' }) })
    emit('event', { payload: {}, type: 'gateway.ready' })
    await vi.waitFor(() => expect(sent('config.get')).toContainEqual({ key: 'busy', session_id: 's1' }))
    await settle()
    given.busy(app.stores, { ...busy })

    await type('/queue later please')
    await press(key('enter'))
    await vi.waitFor(() => expect(sent('prompt.submit')).toHaveLength(1))
    expect(sent('session.steer')).toEqual([])
  })
})
