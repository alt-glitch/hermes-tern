// The sheets take the ports they use, not App: each is driven here on a small fake host.
import type { ModelOptionProvider, SessionLiveInfo } from '@hermes/shared/gateway-events'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionView } from '../app/ports.js'
import { liveSessionId, storedSessionId } from '../core/ids.js'
import { forgetCaps, rememberCaps } from '../modelCaps.js'
import type { Overlay } from '../overlay.js'
import { type EffortHost, openEffortPicker } from '../overlays/effort.js'
import { openThemePicker, type ThemeHost } from '../overlays/theme.js'
import type { ThemeMode } from '../settings.js'

import { FakeGateway, key } from './fakes.js'

afterEach(() => forgetCaps())

/** The one overlay a host was asked to open. */
function only(opened: readonly Overlay[]): Overlay {
  const [overlay, ...rest] = opened

  if (!overlay || rest.length) {
    throw new Error(`expected one overlay, got ${opened.length}`)
  }

  return overlay
}

function themeHost(theme: ThemeMode) {
  const opened: Overlay[] = []
  const host = {
    close: vi.fn<ThemeHost['close']>(),
    open: (o: Overlay) => void opened.push(o),
    setTheme: vi.fn<ThemeHost['setTheme']>(),
    theme
  } satisfies ThemeHost

  return { host, opened }
}

describe('the theme picker on its ports', () => {
  it('previews the selection live and puts the old mode back on Esc', () => {
    const { host, opened } = themeHost('tern')

    openThemePicker(host)
    const sheet = only(opened)

    sheet.onKey(key('down'))
    expect(host.setTheme).toHaveBeenLastCalledWith('nous')

    sheet.onKey(key('escape'))
    expect(host.setTheme).toHaveBeenLastCalledWith('tern')
    expect(host.close).toHaveBeenCalledWith(sheet)
  })

  it('keeps the previewed mode on Enter, and Ctrl+C cancels as Esc does', () => {
    const { host, opened } = themeHost('nous')

    openThemePicker(host)
    const sheet = only(opened)

    sheet.onKey(key('down'))
    sheet.onKey(key('enter'))
    expect(host.setTheme.mock.calls).toEqual([['skin']])
    expect(host.close).toHaveBeenCalledWith(sheet)

    openThemePicker(host)
    const again = opened[1]

    again?.cancel?.()
    expect(host.setTheme).toHaveBeenLastCalledWith('nous')
  })
})

function effortHost(info: SessionLiveInfo | null, replies: ConstructorParameters<typeof FakeGateway>[0] = {}) {
  const gw = new FakeGateway(replies)
  const opened: Overlay[] = []
  const session: SessionView = { info, ref: { live: liveSessionId('s1'), stored: storedSessionId('stored-1') } }
  const host = {
    changed: vi.fn<EffortHost['changed']>(),
    close: vi.fn<EffortHost['close']>(),
    gw: gw.client,
    open: (o: Overlay) => void opened.push(o),
    session,
    setEffort: vi.fn<EffortHost['setEffort']>(async () => undefined)
  } satisfies EffortHost

  return { gw, host, opened }
}

/** A provider whose model `m` cannot turn reasoning off. */
const NO_OFF: ModelOptionProvider[] = [
  { capabilities: { m: { can_disable_reasoning: false, fast: false, reasoning: true } }, models: ['m'], name: 'P', slug: 'p' }
]

/** The effort sheet lists `off` (the `none` level). */
const offersOff = (sheet: Overlay) => JSON.stringify(sheet.node('layer.effort')).includes('"id":"none"')

describe('the effort picker on its ports', () => {
  it("starts on the session's level and sets it for the session on Enter", () => {
    rememberCaps(NO_OFF)
    const { gw, host, opened } = effortHost({ model: 'm', provider: 'p', reasoning_effort: 'high' })

    openEffortPicker(host)
    const sheet = only(opened)

    expect(offersOff(sheet)).toBe(false)
    sheet.onKey(key('enter'))

    expect(host.close).toHaveBeenCalledWith(sheet)
    expect(host.setEffort).toHaveBeenCalledWith('high', 'session')
    expect(gw.calls).toEqual([])
  })

  it('saves the pick as the default after Ctrl+G', () => {
    rememberCaps(NO_OFF)
    const { host, opened } = effortHost({ model: 'm', provider: 'p' })

    openEffortPicker(host)
    const sheet = only(opened)

    sheet.onKey(key('g', { ctrl: true }))
    sheet.onKey(key('down'))
    sheet.onKey(key('enter'))

    expect(host.setEffort).toHaveBeenCalledWith('high', 'global')
  })

  it("loads the model's capabilities for the live session id, and narrows the levels when they come", async () => {
    const { gw, host, opened } = effortHost(
      { model: 'm', provider: 'p' },
      { replies: { 'model.options': () => ({ providers: NO_OFF }) } }
    )

    openEffortPicker(host)
    const sheet = only(opened)

    expect(offersOff(sheet)).toBe(true)
    expect(gw.sent('model.options')).toEqual([{ session_id: 's1' }])

    await vi.waitFor(() => expect(host.changed).toHaveBeenCalled())
    expect(offersOff(sheet)).toBe(false)
  })
})
