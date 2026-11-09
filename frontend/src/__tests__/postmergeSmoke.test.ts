// Adapted from kvnloo/hermes-tern PR #50: one App across browser, media refusal and 3D fanout.
// The separate native Tern pane is outside fakeTern's observable surface.
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Node } from '@stencil-hq/tern'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { modelSources } from '../artifacts.js'
import { readLaunchEnv } from '../config/env.js'
import { browserCaller, listBrowserBlocks } from '../wire/browser.js'

import { FakeGateway, fakeTern, must, settle, topNodes, tree } from './fakes.js'
import { png } from './mediaDeliveryFixtures.js'

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_file, _args, _options, callback) => callback(null, '', ''))
}))
vi.mock('../clipboard.js', () => ({ copyToClipboard: () => undefined }))
vi.mock('../hermes/sessionIndex.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../hermes/sessionIndex.js')>()),
  lastReply: () => '',
  storedSessions: () => []
}))

const oldHome = process.env['HERMES_HOME']
const home = mkdtempSync(join(tmpdir(), 'hermes-tern-postmerge-'))
process.env['HERMES_HOME'] = home
const { App } = await import('../app/chat.js')

const browserMethods = ['blocks', 'adopt', 'focus', 'release', 'frame'].map(method => 'hermes-tern.browser.' + method)
const target = { target_id: '7', title: 'Sample page', url: 'about:blank', in_tern: true, frame: 'main' }

function descendants(n: Node): Node[] {
  return [n, ...n.children.flatMap(descendants)]
}

function mainNodes(tern: ReturnType<typeof fakeTern>): Node[] {
  return topNodes(tern.region('main')).flatMap(descendants)
}

function mainWireNodes(tern: ReturnType<typeof fakeTern>): ReturnType<typeof tree>[] {
  const walk = (n: ReturnType<typeof tree>): ReturnType<typeof tree>[] =>
    [n, ...(n.c ?? []).flatMap(walk)]

  return topNodes(tern.region('main')).flatMap(n => walk(tree(n)))
}

function completeTool(gw: FakeGateway, toolId: string, name: string, args: Record<string, unknown>, result: unknown) {
  gw.event({ type: 'tool.start', session_id: 's1', payload: { tool_id: toolId, name, args } })
  gw.event({ type: 'tool.complete', session_id: 's1', payload: { tool_id: toolId, name, args, result, duration_s: 0.01 } })
}

/** A valid minimal GLB: v2 header and padded JSON chunk. */
function glbBytes(): Buffer {
  const json = Buffer.from('{"asset":{"version":"2.0"}}')
  const padded = Math.ceil(json.length / 4) * 4
  const bytes = Buffer.alloc(20 + padded, 0x20)
  bytes.write('glTF', 0, 'ascii')
  bytes.writeUInt32LE(2, 4)
  bytes.writeUInt32LE(bytes.length, 8)
  bytes.writeUInt32LE(padded, 12)
  bytes.write('JSON', 16, 'ascii')
  json.copy(bytes, 20)

  return bytes
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})
afterAll(() => {
  if (oldHome === undefined) {
    delete process.env['HERMES_HOME']
  } else {
    process.env['HERMES_HOME'] = oldHome
  }
  rmSync(home, { recursive: true, force: true })
})

describe('post-merge App smoke', () => {
  it('routes browser focus, refuses unproven tool images and opens a 3D split in one session, then disposes timers', async () => {
    const imagePath = join(home, 'preview.png')
    const modelPath = join(home, 'scene.glb')
    writeFileSync(imagePath, png)
    writeFileSync(modelPath, glbBytes())

    const gw = new FakeGateway({ replies: {
      'setup.status': () => ({ provider_configured: true }),
      'session.create': () => ({
        info: { cwd: home, profile_name: 'work', stored_session_id: 's1', terminal_backend: 'local' },
        session_id: 's1', subscription_id: 'sub1'
      }),
      'config.get': p => p['key'] === 'profile' ? { profile_name: 'work' } : { config: { display: {} } },
      'gateway.capabilities': () => ({ plugin_methods: [...browserMethods, 'hermes-tern.media.image'] }),
      'hermes-tern.browser.blocks': () => ({
        available: true,
        blocks: [{ target_id: '7', title: target.title, url: target.url, owner: null, owned: false, available: true }]
      }),
      'hermes-tern.browser.focus': () => target
    } })
    const tern = fakeTern({ draws: true, features: ['blobs'] })
    Object.assign(tern.session.caps, { reduceMotion: true })
    const app = new App(tern.session, gw.client, '', { launch: readLaunchEnv({ HOME: home }, home) })
    const done = app.run()
    gw.event({ type: 'gateway.ready', payload: {} })
    await vi.waitFor(() => expect(app.session.ref.live).toBe('s1'))
    await settle(gw)
    expect(app.session.info?.profile_name).toBe('work')
    expect(gw.sent('session.create')).toHaveLength(1)

    const blob = vi.spyOn(tern.session, 'blob').mockReturnValue('smoke-image-blob')
    gw.event({ type: 'message.start', session_id: 's1', payload: {} })

    // The browser card comes from the real tool completion, not an isolated card fixture.
    completeTool(gw, 'browser-1', 'browser_navigate', {}, JSON.stringify({ success: true, tern_target: target }))
    await settle(gw)
    const face = must(mainNodes(tern).find(n => n.props['title'] === 'Focus Tern block 7'), 'rendered browser Focus control')
    expect(face.props['role']).toBe('omp.btn')
    // The click lands on the native button the face sits in (view/ui/button.tsx).
    const focus = must(mainNodes(tern).find(n => n.props['aria'] === 'Focus Tern block 7'), 'native browser Focus button')

    const blocks = await listBrowserBlocks(gw.client, must(browserCaller(app.session)))
    expect(blocks.blocks).toHaveLength(1)
    expect(gw.sent('config.get')).toContainEqual({ key: 'profile', profile: 'work', session_id: 's1' })
    expect(gw.sent('hermes-tern.browser.blocks')).toEqual([{ session_id: 's1' }])
    focus.handlers?.onClick?.({ act: 'click', ev: 'action', id: 'browser-focus', raw: {}, sf: 'hermes' })
    await vi.waitFor(() => expect(gw.sent('hermes-tern.browser.focus')).toEqual([
      { session_id: 's1', target_id: '7' }
    ]))
    expect(gw.sent('hermes-tern.browser.adopt')).toEqual([])

    // A completed tool ID cannot prove gateway ownership. Even an advertised method
    // must not offer Load or ask the gateway for bytes without that proof.
    completeTool(gw, 'image-1', 'read_file', { path: imagePath },
      { resolved_path: imagePath, mime: 'image/png', success: true })
    await settle(gw)
    expect(mainNodes(tern).some(n => n.props['text'] ===
      'Tool image preview unavailable: no authenticated completed-tool evidence.')).toBe(true)
    expect(mainNodes(tern).some(n => ['Load image preview', 'Retry image preview'].includes(String(n.props['title'])))).toBe(false)
    expect(gw.sent('hermes-tern.media.image')).toEqual([])
    await app.stores.mediaDelivery.load({
      kind: 'path', host: 'gateway', id: 'image-1', path: imagePath,
      mime: 'image/png', toolCallId: 'image-1'
    })
    expect(gw.sent('hermes-tern.media.image')).toEqual([])
    expect(blob.mock.calls.filter(([, mime]) => mime === 'image/png')).toEqual([])

    // A query-bearing file URL reaches the live artifact fanout; .glb.html never qualifies.
    const modelUrl = pathToFileURL(modelPath)
    modelUrl.searchParams.set('version', '1')
    const htmlUrl = new URL(modelUrl)
    htmlUrl.pathname += '.html'
    expect(modelSources({ url: modelUrl.href })).toEqual([modelUrl.href])
    expect(modelSources({ url: htmlUrl.href })).toEqual([])
    vi.stubEnv('TERN_PANE', 'smoke-test-pane')
    completeTool(gw, 'model-1', 'mcp__meshy__meshy_download_model', {}, { success: true, model_url: modelUrl.href })
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledWith(
      'tern', ['open', '--split', 'right', modelPath], { timeout: 15_000 }, expect.any(Function)
    ))
    await settle(gw)
    // Session adoption also invokes git through this shared mock. Count the
    // model opens specifically so an unrelated subprocess is not a false failure.
    const calls = vi.mocked(execFile).mock.calls
    expect(calls.some(([command]) => command === 'git')).toBe(true)
    expect(calls.filter(([command, args]) => command === 'tern' &&
      Array.isArray(args) && args[0] === 'open' && args[3] === modelPath)).toHaveLength(1)
    expect(mainWireNodes(tern).some(n => n.k === 'section' && n.p?.['key'] === 'model-1')).toBe(true)
    expect(gw.sent('session.create')).toHaveLength(1)
    expect(gw.sent('session.resume')).toEqual([])

    // The same quit path calls dispose(), which must disarm the timers started by App events.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    gw.event({ type: 'sessions.changed' })
    gw.event({ type: 'gateway.reconnecting', payload: { attempt: 1, delay_ms: 5000 } })
    gw.event({ type: 'notification.show', payload: { key: 'smoke', kind: 'ttl', text: 'Transient notice', ttl_ms: 60_000 } })
    await settle(gw)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    const dispose = vi.spyOn(app, 'dispose')
    app.quit()
    await done
    expect(dispose).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.todo('3D pane pixels: fakeTern cannot observe the separate native pane opened by the tern CLI')
})
