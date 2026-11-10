import type { ActionEvent } from '@stencil-hq/tern'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { settle, setup } from './appSetup.js'
import { key } from './fakes.js'

vi.mock('@hermes/shared/prompt-history', () => ({ append: () => undefined, load: () => [] }))

beforeEach(() => {
  delete process.env['HERMES_TERN_QUERY']
  delete process.env['HERMES_TERN_IMAGE']
})

const fence = '```ephemeral-ui\n{"kind":"merge","app":"github"}\n```'

describe('App: an ephemeral-ui card in an ordinary answer', () => {
  it('keeps the composer typing and draws the answer with its card', async () => {
    const { app, emit, frame, press, sent, type } = setup({}, { features: ['blobs'] })
    await type('show me')
    expect(app.stores.composer.text).toBe('show me')
    await press(key('enter'))
    expect(sent('prompt.submit')).toHaveLength(1)

    emit('event', { payload: { text: `Here:\n\n${fence}\n\nDone.` }, session_id: 's1', type: 'message.complete' })
    await settle()
    await vi.waitFor(() => expect(app.eui.revision).toBeGreaterThan(0), { timeout: 20_000 })

    await settle()
    const drawn = JSON.stringify(frame())
    expect(drawn).toContain('"data-eui-kind":"merge"')
    expect(drawn).toContain('Done.')
    expect(drawn).not.toContain('```ephemeral-ui')

    // A kit button in the drawn card is live: its click replays into the kit and the card redraws.
    type Clickable = { handlers: { onClick: (e: ActionEvent) => void } }
    const find = (n: unknown, text: string, seen = new Set<object>()): Clickable | undefined => {
      if (Array.isArray(n)) return n.map(c => find(c, text, seen)).find(Boolean)
      if (!n || typeof n !== 'object' || seen.has(n)) return undefined
      seen.add(n)
      const p = 'props' in n ? n.props : undefined
      if ('handlers' in n && n.handlers && typeof n.handlers === 'object' && 'onClick' in n.handlers && typeof n.handlers.onClick === 'function'
        && p && typeof p === 'object' && 'text' in p && p.text === text) {
        const onClick = n.handlers.onClick
        return { handlers: { onClick: (e: ActionEvent) => { onClick(e) } } }
      }
      return Object.values(n).map(v => find(v, text, seen)).find(Boolean)
    }
    const rev = app.eui.revision
    const btn = find(frame(), 'View diff')
    expect(btn).toBeDefined()
    btn?.handlers.onClick({ ev: 'action', sf: 'hermes', id: '', act: 'click', raw: {} })
    await vi.waitFor(() => expect(app.eui.revision).toBeGreaterThan(rev), { timeout: 5_000 })
    await settle()
    expect(JSON.stringify(frame())).not.toBe(drawn)
    await type('next')
    expect(app.stores.composer.text).toBe('next')
  }, 60_000)

  it('keeps drawing while the card streams in and mounts mid-answer', async () => {
    const { app, emit, frame, press, type } = setup({}, { features: ['blobs'] })
    await type('show me')
    await press(key('enter'))
    emit('event', { payload: {}, session_id: 's1', type: 'message.start' })
    for (const text of ['Here is the GitHub', ' PR merge card.\n\n```', 'ephemeral-ui\n{"kind": "merge",', ' "app": "github"}\n```', '\n\nDone.']) {
      emit('event', { payload: { text }, session_id: 's1', type: 'message.delta' })
      await settle()
    }
    await vi.waitFor(() => expect(app.eui.revision).toBeGreaterThan(0), { timeout: 20_000 })
    await settle()
    expect(JSON.stringify(frame())).toContain('Done.')
    emit('event', { payload: { text: `Here is the GitHub PR merge card.\n\n${fence}\n\nDone.` }, session_id: 's1', type: 'message.complete' })
    await settle()
    expect(JSON.stringify(frame())).toContain('"data-eui-kind":"merge"')
    await type('next')
    expect(app.stores.composer.text).toBe('next')
  }, 60_000)

  // Live Tern settles finished rows: a card that redraws itself (a click) must still send its row.
  it('redraws a card in a settled row when its button is clicked', async () => {
    const { app, emit, ops, press, type } = setup({}, { features: ['blobs', 'settle'] })
    await type('show me')
    await press(key('enter'))
    emit('event', { payload: { text: `Here:\n\n${fence}\n\nDone.` }, session_id: 's1', type: 'message.complete' })
    await settle()
    await vi.waitFor(() => expect(JSON.stringify(ops())).toContain('View diff'), { timeout: 20_000 })
    await settle()
    // The button's wire id (ids on the wire are full paths): the el whose text is "View diff".
    const id = (function walk(n: unknown, owner?: string): string | undefined {
      if (Array.isArray(n)) return n.map(c => walk(c, owner)).find(Boolean)
      if (!n || typeof n !== 'object') return undefined
      const own = 'id' in n && typeof n.id === 'string' ? n.id : owner
      if (Object.values(n).includes('View diff')) return own
      return Object.values(n).map(v => walk(v, own)).find(Boolean)
    })(ops())
    expect(id).toBeDefined()
    // What the button's onClick runs (live Tern routes the action there: measured in a real window).
    const [, card, el] = /^main\.\w+\.\w+\.(main\.[^.]+\.[^.]+:\d+)\..*\bn(\d+)$/.exec(id ?? '') ?? []
    const before = ops().length
    app.eui.click(card ?? '', Number(el))
    await vi.waitFor(() => expect(JSON.stringify(ops().slice(before))).toContain('Hide diff'), { timeout: 5_000 })
  }, 60_000)
})
