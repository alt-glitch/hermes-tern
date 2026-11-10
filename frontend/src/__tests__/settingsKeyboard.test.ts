import { node, Surface, View } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@hermes/shared/gateway-types'
import { liveSessionId } from '../core/ids.js'
import { openSettings } from '../overlays/settings.js'
import type { Overlay } from '../overlays/overlay.js'
import { PROFILE_PREFERENCES } from '../preferences/contracts.js'
import { settle, setup } from './appSetup.js'
import { key, must, stub, tree } from './fakes.js'

vi.mock('@hermes/shared/prompt-history', () => ({ append: () => undefined, load: () => [] }))

function fixture(options: { preflight?: Promise<{ value: string }>; wrongReadback?: boolean; rejectWrite?: boolean } = {}) {
  const values = new Map(PROFILE_PREFERENCES.map(f => [f.key, f.options?.[0] ?? 'default']))
  let policyReads = 0
  const f = setup({
    'config.get': p => {
      if (p['key'] === 'approvals.mode' && ++policyReads === 2 && options.preflight) return options.preflight
      if (p['key'] === 'approvals.mode' && policyReads >= 3 && options.wrongReadback) return { value: 'manual' }
      return { value: values.get(String(p['key'])) }
    },
    'config.set': p => {
      if (options.rejectWrite) throw new Error('gateway refused setting')
      values.set(String(p['key']), String(p['value']))
      return { key: p['key'], value: p['value'] }
    }
  })
  f.app.session.info = stub<SessionInfo>({ profile_name: 'work' })
  return { ...f, values }
}

async function ask(f: ReturnType<typeof fixture>) {
  openSettings(f.app)
  await vi.waitFor(() => expect(f.sent('config.get').filter(p => p['key'] === 'skin')).toHaveLength(1))
  await settle()
  await f.press(key('tab'))
  await f.press(key('tab'))
  await f.press(key('enter'))
  await f.press(key('down'))
  await f.press(key('enter'))
  const sheet = must(f.app.overlays.find(o => o.key === 'settings'))
  expect(JSON.stringify(tree(sheet.node('layer.settings')))).toContain('Cancel (selected, default)')
  return sheet
}

const render = (sheet: Overlay) => JSON.stringify(tree(sheet.node('layer.settings')))

describe('profile policy keyboard confirmation through App', () => {
  it('keeps default Enter and Escape as cancellation; modified keys do not select or confirm', async () => {
    for (const cancel of ['enter', 'escape']) {
      const f = fixture()
      const sheet = await ask(f)
      await f.press(key('right', { alt: true }))
      await f.press(key('enter', { shift: true }))
      expect(render(sheet)).toContain('Cancel (selected, default)')
      expect(f.sent('config.set')).toEqual([])
      await f.press(key(cancel))
      expect(tree(sheet.node('layer.settings')).k).toBe('prefs')
      expect(f.values.get('approvals.mode')).toBe('manual')
      expect(f.sent('config.set')).toEqual([])
    }
  })

  it('selects explicitly without writing, confirms once with a separate Enter, and retains the draft', async () => {
    const f = fixture()
    f.app.stores.composer.set('draft unchanged', { cursor: 3 })
    const sheet = await ask(f)
    await f.press(key('right'))
    await f.press(key('right'))
    expect(render(sheet)).toContain('Confirm profile policy change (selected)')
    expect(f.sent('config.set')).toEqual([])
    await f.press(key('enter'))
    await f.press(key('enter'))
    await vi.waitFor(() => expect(f.sent('config.set')).toEqual([{ key: 'approvals.mode', value: 'smart', session_id: 's1', profile: 'work' }]))
    await vi.waitFor(() => expect(render(sheet)).toContain('Saved and verified by Hermes'))
    expect(f.sent('config.get').filter(p => p['key'] === 'approvals.mode')).toHaveLength(3)
    expect(f.app.stores.composer.text).toBe('draft unchanged')
    expect(f.app.stores.composer.cursor).toBe(3)
    expect(f.sent('prompt.submit')).toEqual([])
  })

  it('allows reversing selection without navigation counting as consent', async () => {
    const f = fixture()
    const sheet = await ask(f)
    await f.press(key('right'))
    await f.press(key('left'))
    expect(render(sheet)).toContain('Cancel (selected, default)')
    await f.press(key('enter'))
    expect(f.sent('config.set')).toEqual([])
  })

  it('keeps a selected confirmation through modified Ctrl+C and cancels only on bare Ctrl+C', async () => {
    const f = fixture()
    const sheet = await ask(f)
    await f.press(key('right'))
    await f.press(key('c', { ctrl: true, alt: true }))
    expect(render(sheet)).toContain('Confirm profile policy change (selected)')
    expect(f.sent('config.set')).toEqual([])
    await f.press(key('c', { ctrl: true }))
    expect(f.app.overlays).not.toContain(sheet)
    expect(f.sent('config.set')).toEqual([])
    expect(f.values.get('approvals.mode')).toBe('manual')
  })

  it('never acts on covered, closed, or replaced sheet key callbacks', async () => {
    const f = fixture()
    const sheet = await ask(f)
    const blocker: Overlay = { key: 'blocker', modal: true, node: () => node('col', { key: 'blocker' }), onKey: () => true }
    f.app.open(blocker)
    sheet.onKey(key('right'))
    sheet.onKey(key('enter'))
    await f.press(key('right'))
    await f.press(key('enter'))
    expect(f.sent('config.set')).toEqual([])
    f.app.close(blocker)
    expect(render(sheet)).toContain('Cancel (selected, default)')
    openSettings(f.app)
    const replacement = must(f.app.overlays.find(o => o.key === 'settings'))
    expect(replacement).not.toBe(sheet)
    sheet.onKey(key('right'))
    sheet.onKey(key('enter'))
    await settle()
    expect(f.sent('config.set')).toEqual([])
  })

  it('rejects an SDK-captured confirm click after closing, replacement, or profile ABA', async () => {
    for (const transition of ['close', 'replace', 'profile']) {
      const f = fixture()
      const sheet = await ask(f)
      const rendered = { layer: [sheet.node('layer.settings')] }
      const surface = new Surface({ send: () => {}, credits: () => 1, dropped: () => {} }, 'hermes', { mode: 'inline' })
      surface.render(rendered)
      const view = View.from(rendered)
      type Tree = NonNullable<View['regions'][number]>
      const descendants = (nodes: readonly Tree[]): Tree[] => nodes.flatMap(n => [n, ...descendants(n.children)])
      const roots = view.regions.find(region => region?.id === 'layer')?.children ?? []
      const confirm = must(descendants(roots).find(n => n.props['key'] === 'confirm' && n.props['tag'] === 'button'))
      const captured = surface.dispatch({ ev: 'action', sf: 'hermes', id: confirm.id, act: 'click', raw: {} })
      expect(captured).toBeTypeOf('function')
      if (transition === 'close') f.app.close(sheet)
      else if (transition === 'replace') openSettings(f.app)
      else {
        const info = f.app.session.info
        f.app.session.info = stub<SessionInfo>({ profile_name: 'elsewhere' })
        f.app.session.info = info
      }
      await captured?.()
      await settle()
      expect(f.sent('config.set')).toEqual([])
    }
  })

  it('rejects stale session and profile ABA and same-session re-adoption', async () => {
    for (const transition of ['session', 'profile', 'profile-loss', 'adoption']) {
      const f = fixture()
      const sheet = await ask(f)
      await f.press(key('right'))
      const ref = f.app.session.ref
      const info = f.app.session.info
      if (transition === 'session') {
        f.app.session.ref = { ...ref, live: liveSessionId('s2') }
        f.app.session.ref = ref
      } else if (transition === 'profile') {
        f.app.session.info = stub<SessionInfo>({ profile_name: 'elsewhere' })
        f.app.session.info = info
      } else if (transition === 'profile-loss') {
        f.app.session.info = null
        f.app.session.info = info
      } else {
        f.app.session.ref = ref
      }
      await f.press(key('enter'))
      sheet.onKey(key('enter'))
      expect(render(sheet)).toContain('previous session')
      expect(f.sent('config.set')).toEqual([])
    }
  })

  it('invalidates an in-flight preflight after an owner ABA and never duplicates a pending write', async () => {
    const read = Promise.withResolvers<{ value: string }>()
    const f = fixture({ preflight: read.promise })
    const sheet = await ask(f)
    await f.press(key('right'))
    await f.press(key('enter'))
    await vi.waitFor(() => expect(f.sent('config.get').filter(p => p['key'] === 'approvals.mode')).toHaveLength(2))
    await f.press(key('enter'))
    expect(f.sent('config.set')).toEqual([])
    const ref = f.app.session.ref
    f.app.session.ref = { ...ref, live: liveSessionId('s2') }
    f.app.session.ref = ref
    read.resolve({ value: 'manual' })
    await settle()
    expect(f.sent('config.set')).toEqual([])
    expect(render(sheet)).toContain('previous session')
  })

  it('keeps a sheet valid across an unrelated update of the same profile', async () => {
    const f = fixture()
    const sheet = await ask(f)
    f.app.session.info = stub<SessionInfo>({ profile_name: 'work', model: 'new-model' })
    await f.press(key('right'))
    await f.press(key('enter'))
    await vi.waitFor(() => expect(render(sheet)).toContain('Saved and verified by Hermes'))
    expect(f.sent('config.set')).toHaveLength(1)
  })

  it('cancels the write when another overlay takes priority during preflight', async () => {
    const read = Promise.withResolvers<{ value: string }>()
    const f = fixture({ preflight: read.promise })
    const sheet = await ask(f)
    await f.press(key('right'))
    await f.press(key('enter'))
    await vi.waitFor(() => expect(f.sent('config.get').filter(p => p['key'] === 'approvals.mode')).toHaveLength(2))
    const blocker: Overlay = { key: 'blocker', modal: true, node: () => node('col', { key: 'blocker' }), onKey: () => true }
    f.app.open(blocker)
    read.resolve({ value: 'manual' })
    await settle()
    expect(f.sent('config.set')).toEqual([])
    expect(render(sheet)).toContain('Not confirmed')
  })

  it('reports a rejected gateway write without claiming success', async () => {
    const f = fixture({ rejectWrite: true })
    const sheet = await ask(f)
    await f.press(key('right'))
    await f.press(key('enter'))
    await vi.waitFor(() => expect(render(sheet)).toContain('gateway refused setting'))
    expect(render(sheet)).not.toContain('Saved and verified by Hermes')
    expect(f.values.get('approvals.mode')).toBe('manual')
  })

  it('reports a contradictory canonical readback as unconfirmed', async () => {
    const f = fixture({ wrongReadback: true })
    const sheet = await ask(f)
    await f.press(key('right'))
    await f.press(key('enter'))
    await vi.waitFor(() => expect(render(sheet)).toContain('Canonical readback differs'))
    expect(render(sheet)).not.toContain('Saved and verified by Hermes')
    expect(f.sent('config.set')).toHaveLength(1)
  })
})
