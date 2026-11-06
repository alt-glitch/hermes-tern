// The split keeps the public AppActions entry points wired to the same session and Tern view.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { setup } from './appSetup.js'
import { key } from './fakes.js'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))

beforeEach(() => {
  delete process.env['HERMES_TUI_QUERY']
  delete process.env['HERMES_TUI_IMAGE']
})

describe('AppActions split', () => {
  it('keeps sidebar/PR aside arbitration and typed Send on the same action facade', async () => {
    const { app, press, sent, type } = setup({}, { features: ['aside'] })
    expect(app.sidebar.open).toBe(false)
    expect(app.stores.prAside.open).toBe(false)

    app.toggleSidebar()
    expect(app.sidebar.open).toBe(true)

    app.openPrAside(undefined)
    expect(app.sidebar.open).toBe(false)
    expect(app.stores.prAside.open).toBe(true)

    app.toggleSidebar()
    expect(app.sidebar.open).toBe(true)
    expect(app.stores.prAside.open).toBe(false)

    await type('routed after aside')
    await press(key('enter'))
    expect(sent('prompt.submit')).toHaveLength(1)
    expect(sent('prompt.submit')[0]).toMatchObject({ text: 'routed after aside' })
  })

  it('keeps unsupported native sidebars closed and reports the fallback', () => {
    const { app } = setup()
    app.toggleSidebar()

    expect(app.sidebar.open).toBe(false)
    expect(app.transcript.entries.some(e => e.kind === 'notice' && e.text.includes('no side panel'))).toBe(true)
  })
})
