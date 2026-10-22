import type { NodeJson } from '@stencil-hq/tern'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StoredSession } from '../hermes/sessionIndex.js'
import type { PreviewRow, TranscriptReader } from '../hermes/sessionTranscript.js'
import type { Overlay } from '../overlays/overlay.js'

import { FakeGateway, key, must, stub, tree } from './fakes.js'

const copied: string[] = []

vi.mock('../clipboard.js', () => ({ copyToClipboard: (text: string) => copied.push(text) }))

const row = (id: string, title: string): StoredSession => ({
  branch: '', cwd: '/w/app', id, lastActive: Date.now(), messages: 4, model: '', pinned: false,
  preview: `${title} prompt`, repoRoot: '/w/app', source: 'tui', startedAt: Date.now(), title
})

vi.mock('../hermes/sessionIndex.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../hermes/sessionIndex.js')>()),
  storedSessions: () => [row('a', 'First'), row('b', 'Second')],
  workspaceOf: () => Promise.resolve('/w/app')
}))

const { openSessionPicker } = await import('../overlays/sessions.js')

const user = (text: string): PreviewRow => ({ key: text, kind: 'user', steer: false, text })

function setup() {
  const reads: string[] = []
  const reader: TranscriptReader = {
    ends: id => {
      reads.push(`ends ${id}`)

      return Promise.resolve({ firstPrompt: `${id} first`, lastReply: `${id} last` })
    },
    page: (id, after) => {
      reads.push(`page ${id} ${after}`)

      return Promise.resolve(after === 0 ? { next: 5, rows: [user('one'), user('two'), user('three')] } : { next: null, rows: [user('four')] })
    }
  }
  let overlay: Overlay | undefined
  const host = {
    changed: vi.fn(),
    close: vi.fn(),
    gw: new FakeGateway({ replies: { 'session.list': () => ({ sessions: [] }) } }).client,
    open: (o: Overlay) => {
      overlay = o
    },
    resume: vi.fn(() => Promise.resolve()),
    reveal: vi.fn(),
    scroll: vi.fn(),
    session: { info: null, ref: { live: null, stored: null } },
    transcript: { notice: vi.fn() }
  }

  openSessionPicker(stub(host), reader)

  const sheet = must(overlay, 'the picker')
  const draw = (): NodeJson => tree(sheet.node('layer.sessions'))
  const press = (name: string, mods = {}) => {
    sheet.onKey(key(name, mods))

    return draw()
  }

  return { draw, host, press, reads, sheet }
}

describe('the session picker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    copied.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads the selected preview only once the selection rests, and keeps it', async () => {
    const { draw, press, reads } = setup()
    await vi.advanceTimersByTimeAsync(0)
    draw()

    await vi.advanceTimersByTimeAsync(150)
    press('down')
    await vi.advanceTimersByTimeAsync(150)
    press('up')
    await vi.advanceTimersByTimeAsync(199)

    expect(reads).toEqual([])

    await vi.advanceTimersByTimeAsync(1)

    expect(reads).toEqual(['ends a', 'page a 0'])

    press('down')
    await vi.advanceTimersByTimeAsync(200)
    press('up')
    await vi.advanceTimersByTimeAsync(200)

    expect(reads).toEqual(['ends a', 'page a 0', 'ends b', 'page b 0'])
  })

  it('→ focuses the preview, ↓ steps through it, and stepping near the end reads the next page', async () => {
    const { draw, host, press, reads } = setup()
    await vi.advanceTimersByTimeAsync(0)
    draw()
    await vi.advanceTimersByTimeAsync(200)
    draw()

    expect(press('right').p?.['focus']).toBe('preview')
    expect(host.reveal).toHaveBeenLastCalledWith('layer.sessions.first')

    press('down')
    press('down')

    expect(host.reveal).toHaveBeenLastCalledWith('layer.sessions.m0')
    expect(reads).not.toContain('page a 5')

    press('down')

    expect(host.reveal).toHaveBeenLastCalledWith('layer.sessions.m1')
    expect(reads).toContain('page a 5')

    press('page_down')

    expect(host.scroll).toHaveBeenLastCalledWith('layer.sessions.m1', 'page-down')

    expect(press('left').p?.['focus']).toBe('list')
  })

  it('copies the whole id with ⌥C, and c in the preview', async () => {
    const { draw, press } = setup()
    await vi.advanceTimersByTimeAsync(0)
    draw()

    press('c', { alt: true })
    press('right')
    press('c')

    expect(copied).toEqual(['a', 'a'])
  })

  it('types into the search from the preview, and Escape steps back before it closes', async () => {
    const { draw, host, press } = setup()
    await vi.advanceTimersByTimeAsync(0)
    draw()
    await vi.advanceTimersByTimeAsync(200)
    draw()
    press('right')

    const typed = press('s', { text: 's' })

    expect(typed.p?.['query']).toBe('s')
    expect(typed.p?.['focus']).toBe('list')

    press('right')
    press('escape')

    expect(host.close).not.toHaveBeenCalled()

    press('escape')
    press('escape')

    expect(host.close).toHaveBeenCalled()
  })
})
