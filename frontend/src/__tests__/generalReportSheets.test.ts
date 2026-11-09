// App-level regression checks use the actual Tern JSX Node implementation.
import { EventEmitter } from 'node:events'

import { Node, Session, type Op } from '@stencil-hq/tern'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@tui/types.js'
import { copyToClipboard } from '../clipboard.js'
import { storedSessionId } from '../core/ids.js'
import { openSettings } from '../overlays/settings.js'
import { isReportCommand } from '../reports.js'

import { App, setup, settle } from './appSetup.js'
import { FakeGateway, given, key, must, stub, stubOverlay, tree } from './fakes.js'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))
vi.mock('../clipboard.js', () => ({ copyToClipboard: vi.fn() }))

beforeEach(() => {
  delete process.env['HERMES_TUI_QUERY']
  delete process.env['HERMES_TUI_IMAGE']
  vi.mocked(copyToClipboard).mockReset()
})

function sheetView(app: ReturnType<typeof setup>['app']) {
  const overlay = app.overlays.find(o => o.key === 'operational')
  const root = overlay ? tree(overlay.node('layer.overlay-1')) : undefined
  const collect = (n: typeof root): NonNullable<typeof root>[] =>
    n ? [n, ...(n.c ?? []).flatMap(collect)] : []

  return { root, body: collect(root).find(n => n.p?.['role'] === 'omp.report.body')?.p?.['text'] }
}

async function command(f: ReturnType<typeof setup>, text: string) {
  await f.type(text)
  await f.press(key('enter'))
  await settle()
}

describe('native general report sheets', () => {
  it('opens notice snapshots on demand and removes them on session adoption', () => {
    const f = setup()
    f.app.stores.composer.set('unfinished', { cursor: 3 })
    f.app.stores.notices.show({ key: 'error', kind: 'sticky', level: 'error', text: 'credit access paused' })
    f.app.openNotices()
    const sheet = must(f.app.overlays.at(-1))
    expect(sheetView(f.app).body).toContain('credit access paused')
    given.session(f.app, 's2')
    f.app.operations.adopt('s2')
    expect(f.app.overlays).toEqual([])
    sheet.onKey(key('c'))
    expect(copyToClipboard).not.toHaveBeenCalled()
    expect(f.app.stores.composer.text).toBe('unfinished')
    expect(f.app.stores.composer.cursor).toBe(3)
  })
  it.each(['/usage', '/context', '/status', '/help usage'])('%s shows exact Markdown without main transcript churn', async name => {
    const text = '# Report\n\nUnicode 🦉 **literal**\n'
    const f = setup({ 'slash.exec': () => ({ output: text }) })
    const before = [...f.app.transcript.entries]
    await command(f, name)
    expect(f.sent('slash.exec')).toEqual([{ command: name.slice(1), session_id: 's1' }])
    expect(sheetView(f.app).root?.p?.['role']).toBe('omp.overlay.report')
    expect(sheetView(f.app).body).toBe(text)
    expect(f.app.transcript.entries).toEqual(before)
  })

  it('renders the existing native report overlay into a real SDK Session/View surface', async () => {
    const input = new EventEmitter()
    const tern = new Session(input, { write() {} }, { exitHooks: false, record: '' })
    const connecting = tern.handshake()
    input.emit('data', `\x1b_tsp;r;${JSON.stringify({ ...tern.caps, r: 'hello', v: 1, term: 'fixture', ver: '0', credits: 64 })}\x1b\\`)
    expect(await connecting).toBe(true)

    const gw = new FakeGateway()
    const app = new App(tern, gw.client, 'fixture')
    const running = app.run()
    const surface = must(tern.surfaces[0])
    const rendered: Op[] = []
    const original = surface.send.bind(surface)

    surface.send = ops => { rendered.push(...ops); original(ops) }

    try {
      given.session(app, 's1')
      const before = [...app.transcript.entries]
      app.stores.composer.set('  draft 🦉  ', { cursor: 3 })
      app.operations.showText('/history', '# Native\n\nExact 🦉')
      await new Promise<void>(resolve => setImmediate(resolve))
      await new Promise<void>(resolve => setImmediate(resolve))
      const nodes = rendered.filter(op => op[0] === 'add' && (op[1] === 'layer' || op[1].startsWith('layer.')))
      expect(JSON.stringify(nodes)).toContain('omp.overlay.report')
      expect(JSON.stringify(nodes)).toContain('Exact 🦉')
      expect(app.transcript.entries).toEqual(before)
      app.close(must(app.overlays.at(-1)))
      expect(app.stores.composer.text).toBe('  draft 🦉  ')
      expect(app.stores.composer.cursor).toBe(3)
    } finally {
      app.quit()
      await running
    }
  })

  it('retains the existing native bare /help and does not issue slash.exec', async () => {
    const f = setup({ 'commands.catalog': () => ({ categories: [] }) })
    await command(f, '/help')
    expect(f.app.overlays.at(-1)?.key).toBe('help')
    expect(f.sent('slash.exec')).toEqual([])
  })

  it('routes local history and canonical tools.show into the one report sheet', async () => {
    const f = setup({ 'tools.show': () => ({ sections: [{ name: 'Built-ins', tools: [{ name: 'read_file' }] }], total: 1 }) })
    const before = [...f.app.transcript.entries]
    await command(f, '/history')
    expect(sheetView(f.app).body).toBe('No conversation yet.')
    f.app.close(must(f.app.overlays.at(-1)))
    await command(f, '/tools list')
    expect(f.sent('tools.show')).toEqual([{ session_id: 's1' }])
    expect(sheetView(f.app).body).toBe('[Built-ins] read_file\nTotal: 1 tools')
    expect(f.app.transcript.entries).toEqual(before)
  })

  it('nonreport compress keeps its old panel and report-shaped output grants no authority', async () => {
    const f = setup({ 'slash.exec': () => ({ output: '# Report-ish' }) }, { canonical: false })
    await command(f, '/compress')
    expect(sheetView(f.app).root).toBeUndefined()
    expect(f.app.transcript.entries.at(-1)).toMatchObject({ kind: 'panel', title: '/compress' })
    for (const [name, arg] of [['status', 'set'], ['tools', 'disable'], ['mcp', 'reload'], ['ssh', 'remove'], ['unknown', '']]) {
      expect(isReportCommand(must(name), must(arg))).toBe(false)
    }
  })

  it('copies exact Unicode and trailing newline, not the main conversation', async () => {
    const body = '# Report\nUnicode 🦉\n'
    const f = setup({ 'slash.exec': () => ({ output: body }) })
    const before = [...f.app.transcript.entries]
    await command(f, '/usage')
    const sheet = must(f.app.overlays.at(-1))
    sheet.onKey(key('c'))
    expect(copyToClipboard).toHaveBeenCalledWith(body)
    expect(f.app.transcript.entries).toEqual(before)
  })

  it('shows a clipboard failure only inside the native report and never alters the transcript', () => {
    const f = setup()
    const before = [...f.app.transcript.entries]
    f.app.operations.showText('/history', 'Unicode 🦉 report-only')
    vi.mocked(copyToClipboard).mockImplementationOnce(() => { throw new Error('terminal clipboard unavailable') })
    must(f.app.overlays.at(-1)).onKey(key('c'))
    const report = f.app.overlays.at(-1)
    const root = tree(must(report).node('layer.overlay-1'))
    expect(JSON.stringify(root)).toContain('Could not copy the report to the clipboard.')
    expect(f.app.transcript.entries).toEqual(before)
  })

  it('closes with the exact main draft and caret intact; stale copy is refused', () => {
    const f = setup()
    f.app.stores.composer.set('  Unicode 🦉 unsent  ', { cursor: 5 })
    const before = [...f.app.transcript.entries]
    f.app.operations.showText('/history', 'Report only')
    const sheet = must(f.app.overlays.at(-1))
    sheet.onKey(key('escape'))
    sheet.onKey(key('c'))
    expect(f.app.overlays).toEqual([])
    expect(f.app.stores.composer.text).toBe('  Unicode 🦉 unsent  ')
    expect(f.app.stores.composer.cursor).toBe(5)
    expect(f.app.transcript.entries).toEqual(before)
    expect(copyToClipboard).not.toHaveBeenCalled()
  })

  it('rejects replaced, closed and adopted old report results', () => {
    const f = setup()
    const first = must(f.app.operations.begin('/usage', 's1'))
    const newer = must(f.app.operations.begin('/context', 's1'))
    expect(f.app.operations.finish(first, 'old secret')).toBe(false)
    expect(f.app.operations.finish(newer, '# current')).toBe(true)
    first.sheet.onKey(key('c'))
    expect(copyToClipboard).not.toHaveBeenCalled()
    expect(sheetView(f.app).body).toBe('# current')
    f.app.close(newer.sheet)
    expect(f.app.operations.finish(newer, 'late closed')).toBe(false)
    given.session(f.app, 's2')
    f.app.operations.adopt('s2')
    expect(f.app.overlays).toEqual([])
  })

  it('invalidates a completed report on same-session reattach without disturbing an approval or draft', async () => {
    const f = setup({ 'session.resume': () => ({ session_id: 's1', subscription_id: 'new-sub', info: { stored_session_id: 's1' } }) })
    f.app.stores.composer.set('draft !literal', { cursor: 3, pasted: ['!literal'] })
    f.app.operations.showText('/history', 'OLD REPORT')
    const report = must(f.app.overlays.at(-1))
    const root = report.node('layer.overlay-1')
    if (!(root instanceof Node)) throw new Error('expected report node')
    const flatten = (n: Node): Node[] => [n, ...n.children.filter((child): child is Node => child instanceof Node).flatMap(flatten)]
    const copy = must(flatten(root).find(n => n.props['aria'] === 'Copy')?.handlers?.onClick)
    const approval = stubOverlay('approval', { modal: true })
    f.app.open(approval)
    const before = f.app.session.ref

    await f.app.stores.life.reattach(storedSessionId('s1'))
    expect(f.app.session.ref).not.toBe(before)
    expect(f.app.session.ref.live).toBe('s1')
    expect(f.app.overlays).toEqual([approval])
    report.onKey(key('c'))
    copy({ ev: 'action', sf: 'hermes', id: 'layer.overlay-1.body.actions.copy', act: 'click', raw: {} })
    expect(copyToClipboard).not.toHaveBeenCalled()
    expect(f.app.stores.composer.text).toBe('draft !literal')
    expect(f.app.stores.composer.cursor).toBe(3)
    expect(f.app.stores.composer.pasted).toEqual(['!literal'])
  })

  it('invalidates a pending report and the Settings owner together on same-ID reattach', async () => {
    const pending = Promise.withResolvers<unknown>()
    const f = setup({
      'config.get': () => ({ value: 'manual' }),
      'session.resume': () => ({ session_id: 's1', subscription_id: 'new-sub', info: { stored_session_id: 's1', profile_name: 'work' } }),
      'tools.show': () => pending.promise
    })
    f.app.session.info = stub<SessionInfo>({ profile_name: 'work' })
    f.app.stores.composer.set('unsent', { cursor: 2 })
    const request = f.app.operations.showTools()
    const report = must(f.app.overlays.at(-1))
    openSettings(f.app)
    await vi.waitFor(() => expect(f.sent('config.get').some(p => p['key'] === 'skin')).toBe(true))
    const settings = must(f.app.overlays.at(-1))
    expect(settings.key).toBe('settings')
    expect(tree(settings.node('layer.settings')).k).toBe('prefs')

    await f.app.stores.life.reattach(storedSessionId('s1'))
    expect(f.app.overlays).toEqual([settings])
    expect(JSON.stringify(tree(settings.node('layer.settings')))).toContain('belongs to a previous session')
    pending.resolve({ sections: [{ name: 'old', tools: [{ name: 'private_old_tool' }] }], total: 1 })
    await request
    report.onKey(key('c'))
    expect(copyToClipboard).not.toHaveBeenCalled()
    expect(f.sent('config.set').filter(p => p['key'] !== 'show_reasoning')).toEqual([])
    expect(f.app.stores.composer.text).toBe('unsent')
    expect(f.app.stores.composer.cursor).toBe(2)
  })

  it('closes the old report on observed session loss and rejects its late reply', async () => {
    const pending = Promise.withResolvers<unknown>()
    const f = setup({ 'tools.show': () => pending.promise })
    f.app.stores.composer.set('unsent', { cursor: 2 })
    const request = f.app.operations.showTools()
    const report = must(f.app.overlays.at(-1))
    const approval = stubOverlay('approval', { modal: true })
    f.app.open(approval)
    f.app.stores.life.lost()
    expect(f.app.overlays).toEqual([approval])
    expect(f.app.session.ref.live).toBeNull()
    pending.resolve({ sections: [{ name: 'old', tools: [{ name: 'stale_tool' }] }], total: 1 })
    await request
    report.onKey(key('c'))
    expect(copyToClipboard).not.toHaveBeenCalled()
    expect(f.app.stores.composer.text).toBe('unsent')
    expect(f.app.stores.composer.cursor).toBe(2)
  })

  it('rejects pending and already selected report actions across same-ID and A to B to A adoption', async () => {
    const pending = [Promise.withResolvers<unknown>(), Promise.withResolvers<unknown>()]
    let index = 0
    const f = setup({
      'tools.show': () => pending[index++]?.promise,
      'session.resume': params => ({ session_id: params['session_id'], subscription_id: `sub-${index}`, info: { stored_session_id: params['session_id'] } })
    })
    const first = f.app.operations.showTools()
    const stale = must(f.app.overlays.at(-1))
    await f.app.stores.life.reattach(storedSessionId('s1'))
    expect(f.app.overlays).toEqual([])
    const second = f.app.operations.showTools()
    const current = must(f.app.overlays.at(-1))
    pending[1]?.resolve({ sections: [{ name: 'new', tools: [{ name: 'current_tool' }] }], total: 1 })
    await second
    expect(sheetView(f.app).body).toContain('current_tool')
    pending[0]?.resolve({ sections: [{ name: 'old', tools: [{ name: 'stale_tool' }] }], total: 1 })
    await first
    expect(sheetView(f.app).body).toContain('current_tool')
    expect(sheetView(f.app).body).not.toContain('stale_tool')
    stale.onKey(key('c'))
    expect(copyToClipboard).not.toHaveBeenCalled()
    current.onKey(key('c'))
    expect(copyToClipboard).toHaveBeenCalledWith('[new] current_tool\nTotal: 1 tools')
    vi.mocked(copyToClipboard).mockClear()
    await f.app.stores.life.reattach(storedSessionId('s2'))
    await f.app.stores.life.reattach(storedSessionId('s1'))
    expect(f.app.overlays).toEqual([])
    current.onKey(key('c'))
    expect(copyToClipboard).not.toHaveBeenCalled()
  })

  it('late asynchronous slash output cannot reopen a closed native report', async () => {
    const pending = Promise.withResolvers<unknown>()
    const f = setup({ 'slash.exec': () => pending.promise })
    await command(f, '/usage')
    f.app.close(must(f.app.overlays.at(-1)))
    pending.resolve({ output: 'PRIVATE late' })
    await settle()
    expect(f.app.overlays).toEqual([])
    expect(JSON.stringify(f.app.transcript.entries)).not.toContain('PRIVATE late')
  })

  it('rejects an in-flight report after session adoption instead of showing private output', async () => {
    const pending = Promise.withResolvers<unknown>()
    const f = setup({ 'slash.exec': () => pending.promise })
    await command(f, '/usage')
    given.session(f.app, 's2')
    f.app.operations.adopt('s2')
    pending.resolve({ output: 'OTHER SESSION PRIVATE' })
    await settle()
    expect(f.app.overlays).toEqual([])
    expect(JSON.stringify(f.app.transcript.entries)).not.toContain('OTHER SESSION PRIVATE')
  })

  it('a later approval remains topmost and blocks stale copy', async () => {
    const pending = Promise.withResolvers<unknown>()
    const f = setup({ 'slash.exec': () => pending.promise })
    await command(f, '/usage')
    const report = must(f.app.overlays.at(-1))
    const approval = stubOverlay('approval', { modal: true })
    f.app.open(approval)
    pending.resolve({ output: 'report under approval' })
    await settle()
    expect(f.app.overlays.at(-1)).toBe(approval)
    report.onKey(key('c'))
    expect(copyToClipboard).not.toHaveBeenCalled()
    f.app.close(approval)
    expect(sheetView(f.app).body).toBe('report under approval')
  })

  it('pre-existing approval preempts a new report', () => {
    const f = setup()
    const approval = stubOverlay('approval', { modal: true })
    f.app.open(approval)
    expect(f.app.operations.begin('/usage', 's1')).toBeUndefined()
    expect(f.app.overlays).toEqual([approval])
  })
})
