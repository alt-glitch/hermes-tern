// The app on the fakes, for the App tests: a fake Tern session and gateway, keys in and requests
// out (see fakes.ts). A test file using it mocks '@hermes/shared/prompt-history' itself, as vi.mock is
// hoisted per file, and resets HERMES_TERN_QUERY and HERMES_TERN_IMAGE before each test.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Key, Node } from '@stencil-hq/tern'
import { expect, vi } from 'vitest'

import { toolCallId } from '../core/ids.js'
import type { ToolCall } from '../model.js'

import { face, FakeGateway, fakeTern, given, key, must, type Reply, settle as settleGateway, topNodes } from './fakes.js'
import type { Recorder } from '../hermes/dictation.js'

/** This file's HERMES_HOME, set before App loads. */
export const home = mkdtempSync(join(tmpdir(), 'hermes-tern-app-'))
process.env['HERMES_HOME'] = home

export const { App } = await import('../app/chat.js')

/** A PNG on disk, for a pasted image path. */
export const png = join(home, 'shot.png')
writeFileSync(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]))

/** The gateway of the app the running test set up. */
let gateway: FakeGateway

/** The app on a fake Tern and gateway: keys go in, gateway requests come out. */
export function setup(
  replies: Record<string, Reply> = {},
  { features = [], recorder }: { features?: string[]; recorder?: Recorder } = {}
) {
  const gw = (gateway = new FakeGateway({ replies }))
  let uploads = 0

  if (!replies['image.attach_bytes']) {
    gw.handlers.set('image.attach_bytes', () => ({ path: `/uploads/${++uploads}.png` }))
  }

  const tern = fakeTern({ cols: 100, draws: true, features })
  const app = new App(tern.session, gw.client, '1.0.0', recorder ? { recorder } : {})
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
      actions: r.children.map(face).flatMap(c => (c.props['role'] === 'omp.queue.steer' ? ['steer'] : c.props['role'] === 'omp.queue.edit' ? ['edit'] : [])),
      text: r.children.find(c => c.props['text'] !== undefined)?.props['text']
    }))
  }

  /** The dock's top nodes as last rendered. */
  const dock = () => topNodes(tern.region('dock'))

  return { app, attach, dock, emit, frame: () => tern.frame, ops: () => tern.ops, press, queuedRows, sent, tern, type }
}

/** Waits until the app has handled what the test fed it (no fixed sleep). */
export const settle = () => settleGateway(gateway)
/** A running turn's busy state, for `given.busy`. */
export const busy = { label: 'Working…', since: {}, startedAt: 0 }

// Connection-card fixtures share wire builders, but each test owns its gateway, apps and input.
const { toolNode } = await import('../view/tools/shell.js')

export const flush = () => new Promise(resolve => setImmediate(resolve))

export const OWNER = { session_id: 's1', type: 'session' }
export const FIGMA = 'https://portal/connect/figma'

/** A target as `Target.snapshot` sends it. */
export const figma = (state: string, over: Record<string, unknown> = {}) => ({
  action: 'connect',
  connect_url: FIGMA,
  kind: 'connector',
  name: 'figma',
  resolved: state === 'connected' || state === 'skipped',
  state,
  ...over
})

/** `connection.request` for operation `op` of call `call`. */
export const request = (op = 'op1', call = 'call_f', targets: unknown[] = [figma('initiated')]) => ({
  payload: { deadline_at: Date.now() / 1000 + 300, op_id: op, seq: 2, targets, timeout_seconds: 300, tool_call_id: call },
  session_id: 's1',
  type: 'connection.request'
})

/** `connection.update` frame `seq` of operation `op`. */
export const update = (seq: number, targets: unknown[], over: Record<string, unknown> = {}, op = 'op1') => ({
  payload: { deadline_at: Date.now() / 1000 + 300, op_id: op, owner: OWNER, seq, settled: false, targets, ...over },
  session_id: 's1',
  type: 'connection.update'
})

export const toolStart = (id = 'call_f') => ({
  payload: { args: { action: 'connect', connectors: ['figma'] }, name: 'manage_connections', tool_id: id },
  session_id: 's1',
  type: 'tool.start'
})

export const view = (call: ToolCall) => JSON.stringify(toolNode(call, Date.now()))

/** A connection test's isolated gateway, input and awaited app lifetimes. */
export function connectionFixture() {
  let gw = new FakeGateway()
  gw.handlers.set('setup.status', () => ({ provider_configured: true }))
  gw.handlers.set('session.create', () => ({ info: { stored_session_id: 's1' }, session_id: 's1', subscription_id: 'sub1' }))
  let tern: ReturnType<typeof fakeTern>
  const running = new Map<InstanceType<typeof App>, ReturnType<InstanceType<typeof App>['run']>>()

  async function started() {
    tern = fakeTern()
    const app = new App(tern.session, gw.client, '')
    running.set(app, app.run())
    gw.event({ payload: {}, type: 'gateway.ready' })
    await flush()
    await flush()

    return app
  }

  /** A running turn with the connect call started and its card requested. */
  async function waitingOnFigma(targets: unknown[] = [figma('initiated')]) {
    const app = await started()
    gw.event({ payload: {}, session_id: 's1', type: 'message.start' })
    gw.event(toolStart())
    gw.event(request('op1', 'call_f', targets))
    await flush()

    return { app, call: must(app.transcript.call(toolCallId('call_f'))) }
  }

  const click = async (act: string, value: string) => {
    tern.send({ act, ev: 'action', value })
    await flush()
    await flush()
  }

  const dispose = async () => {
    for (const app of running.keys()) {
      app.quit()
    }
    await Promise.all(running.values())
    running.clear()
  }

  return {
    click,
    dispose,
    get gw() {
      return gw
    },
    set gw(value: FakeGateway) {
      gw = value
    },
    get tern() {
      return tern
    },
    running,
    started,
    waitingOnFigma
  }
}
