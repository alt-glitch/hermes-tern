import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Key } from '@stencil-hq/tern'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))

const home = mkdtempSync(join(tmpdir(), 'hermes-tern-app-'))
process.env.HERMES_HOME = home

const { App } = await import('../app.js')

type Handler = (arg: unknown) => void
type Reply = (params: Record<string, unknown>) => unknown

/** A PNG on disk, for a pasted image path. */
const png = join(home, 'shot.png')
writeFileSync(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]))

function key(name: string, mods: Partial<Key> = {}): Key {
  return { alt: false, ctrl: false, meta: false, name, shift: false, ...mods } as Key
}

/** The app on a fake Tern and gateway: keys go in, gateway requests come out. */
function setup(replies: Record<string, Reply> = {}) {
  const handlers = new Map<string, Handler>()
  const requests: { method: string; params: Record<string, unknown> }[] = []
  let uploads = 0

  const gw = {
    drain: () => undefined,
    isCanonical: true,
    kill: () => undefined,
    on: (name: string, fn: Handler) => void handlers.set(name, fn),
    request: (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params })

      if (method === 'image.attach_bytes') {
        return Promise.resolve({ path: `/uploads/${++uploads}.png` })
      }

      const reply = replies[method]

      try {
        return Promise.resolve(reply ? reply(params) : {})
      } catch (error) {
        return Promise.reject(error)
      }
    }
  }

  const waiting: ((r: IteratorResult<{ type: 'key'; key: Key }>) => void)[] = []
  const surface = { closed: false, focus: () => undefined, palette: () => undefined, render: () => undefined, stylesheet: () => undefined }

  const tern = {
    blob: () => 'blob',
    caps: { cols: 100, features: [] as string[] },
    close: async () => undefined,
    open: () => surface,
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<{ type: 'key'; key: Key }>>(resolve => waiting.push(resolve)),
      return: async () => ({ done: true as const, value: undefined })
    })
  }

  const app = new App(tern as never, gw as never, '1.0.0')
  void app.run()
  app.sid = 's1'

  const press = async (k: Key) => {
    await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0))
    waiting.shift()?.({ done: false, value: { key: k, type: 'key' } })
    await settle()
  }

  const type = async (text: string) => {
    for (const ch of text) {
      await press(key(ch, { text: ch }))
    }
  }

  const attach = async () => {
    await press(key('paste', { text: png }))
    await vi.waitFor(() => expect(requests.some(r => r.method === 'image.attach_bytes')).toBe(true))
    await settle()
  }

  const emit = (name: string, arg: unknown) => handlers.get(name)?.(arg)
  const sent = (method: string) => requests.filter(r => r.method === method).map(r => r.params)

  return { app, attach, emit, press, requests, sent, type }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 5))
const busy = { label: 'Working…', since: {}, startedAt: 0 }

beforeEach(() => {
  delete process.env.HERMES_TUI_QUERY
  delete process.env.HERMES_TUI_IMAGE
})

afterEach(() => {
  vi.useRealTimers()
})

describe('App: images in the draft', () => {
  it('a prompt queued behind the turn takes the images attached with it', async () => {
    const { app, attach, emit, press, sent, type } = setup()
    app.busy = { ...busy }
    await attach()
    await type('first')
    await press(key('enter'))
    expect(app.queue).toMatchObject([{ images: [{ path: '/uploads/1.png' }], text: 'first' }])

    // Typed while the first waits: no images of its own.
    await type('second')
    await press(key('enter'))
    emit('event', { payload: { text: 'done' }, session_id: 's1', type: 'message.complete' })
    await settle()

    const [submit] = sent('prompt.submit')
    expect(submit).toMatchObject({ attachments: [{ path: '/uploads/1.png' }], text: 'first' })
    expect(app.queue).toMatchObject([{ images: [], text: 'second' }])
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

  it('Alt+Up brings a queued prompt back with its images', async () => {
    const { app, attach, press, type } = setup()
    app.busy = { ...busy }
    await attach()
    await type('edit me')
    await press(key('enter'))
    await press(key('up', { alt: true }))

    expect(app.composer.text).toBe('edit me')
    expect(app.queue).toEqual([])
    // Back in the draft: Ctrl+D still sees it.
    const quit = vi.spyOn(app, 'quit')
    app.composer.set('')
    await press(key('d', { ctrl: true }))
    expect(quit).not.toHaveBeenCalled()
  })
})

describe('App: Ctrl+C with a sheet open', () => {
  it('denies an approval instead of clearing the hidden draft or interrupting the turn', async () => {
    const { app, emit, press, sent, type } = setup()
    await type('half typed')
    app.busy = { ...busy }
    const respond = vi.fn()
    emit('request', { fail: vi.fn(), id: 'r1', method: 'approval', params: { command: 'rm -rf x', session_id: 's1' }, respond })
    await settle()
    expect(app.overlays).toHaveLength(1)

    await press(key('c', { ctrl: true }))
    expect(respond).toHaveBeenCalledWith({ choice: 'deny' })
    expect(app.overlays).toHaveLength(0)
    expect(app.composer.text).toBe('half typed')
    expect(sent('session.interrupt')).toEqual([])
    expect(app.busy).not.toBeNull()
  })

  it('cancels a secret prompt with the empty value, and closes a picker', async () => {
    const { app, emit, press } = setup()
    const respond = vi.fn()
    emit('request', { fail: vi.fn(), id: 'r2', method: 'secret', params: { env_var: 'KEY', session_id: 's1' }, respond })
    await settle()
    await press(key('x', { text: 'x' }))
    await press(key('c', { ctrl: true }))
    expect(respond).toHaveBeenCalledWith({ value: '' })

    app.open({ key: 'picker', modal: true, node: () => null as never, onKey: () => true })
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
    const { app, press, sent, type } = setup({ 'shell.exec': p => ({ code: 0, stderr: '', stdout: `<${String(p.command)}>\n` }) })
    await type('today is {!date} ok')
    await press(key('enter'))
    await vi.waitFor(() => expect(sent('prompt.submit')).toHaveLength(1))

    expect(sent('prompt.submit')[0]).toMatchObject({ text: 'today is <date> ok' })
    expect(app.transcript.entries.find(e => e.kind === 'user')).toMatchObject({ text: 'today is {!date} ok' })
  })

  it('refuses the prompt when a {!cmd} cannot run and puts it back in the composer', async () => {
    const { app, press, sent, type } = setup({
      'shell.exec': () => {
        throw new Error('dangerous_command')
      }
    })
    await type('x {!rm -rf /}')
    await press(key('enter'))
    await vi.waitFor(() => expect(app.busy).toBeNull())

    expect(sent('prompt.submit')).toEqual([])
    expect(app.composer.text).toBe('x {!rm -rf /}')
    expect(app.transcript.entries.at(-1)).toMatchObject({ kind: 'notice', tone: 'error' })
  })
})
