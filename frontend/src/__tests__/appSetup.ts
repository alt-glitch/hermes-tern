// The app on the fakes, for the App tests: a fake Tern session and gateway, keys in and requests
// out (see fakes.ts). A test file using it mocks '@tui/lib/history.js' itself, as vi.mock is
// hoisted per file, and resets HERMES_TUI_QUERY and HERMES_TUI_IMAGE before each test.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Key, Node } from '@stencil-hq/tern'
import { expect, vi } from 'vitest'

import { face, FakeGateway, fakeTern, given, key, type Reply, settle as settleGateway, topNodes } from './fakes.js'

/** This file's HERMES_HOME, set before App loads. */
export const home = mkdtempSync(join(tmpdir(), 'hermes-tern-app-'))
process.env['HERMES_HOME'] = home

export const { App } = await import('../app/chat.js')

/** A PNG on disk, for a pasted image path. */
export const png = join(home, 'shot.png')
writeFileSync(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]))

/** The gateway of the app the running test set up. */
let gateway: FakeGateway

/** The app on a fake Tern and gateway: keys go in, gateway requests come out (`canonical`: the shared gateway). */
export function setup(replies: Record<string, Reply> = {}, { canonical = true, features = [] }: { canonical?: boolean; features?: string[] } = {}) {
  const gw = (gateway = new FakeGateway({ canonical, replies }))
  let uploads = 0

  if (!replies['image.attach_bytes']) {
    gw.handlers.set('image.attach_bytes', () => ({ path: `/uploads/${++uploads}.png` }))
  }

  const tern = fakeTern({ cols: 100, draws: true, features })
  const app = new App(tern.session, gw.client, '1.0.0')
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

  return { app, attach, emit, press, queuedRows, sent, type }
}

/** Waits until the app has handled what the test fed it (no fixed sleep). */
export const settle = () => settleGateway(gateway)
/** A running turn's busy state, for `given.busy`. */
export const busy = { label: 'Working…', since: {}, startedAt: 0 }
