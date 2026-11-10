// Open-instance native ownership regressions. The terminal peer and Session,
// Surface, View and dispatch are the pinned SDK's, never fake Tern handlers.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import { node, Session, Surface, type TspEvent, View } from '@stencil-hq/tern'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { App } from '../app/chat.js'
import { readLaunchEnv } from '../config/env.js'
import { entryId } from '../core/ids.js'
import { nativeOverlayKey, withinOverlayRoot } from '../overlays/identity.js'
import { openModelPicker } from '../overlays/models.js'
import type { Overlay } from '../overlays/overlay.js'
import { INPUT_ID } from '../surface/host.js'

import { FakeGateway, must } from './fakes.js'
import { Peer } from './surfacePeer.js'

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function painted() {
  for (let i = 0; i < 8; i++) {
    await turn()
  }
}

interface Harness {
  readonly app: App
  readonly gw: FakeGateway
  readonly peer: Peer
  readonly surface: Surface
  event(body: Record<string, unknown>): Promise<void>
}

async function withApp(
  check: (h: Harness) => Promise<void>,
  { retention = true, credits = 64 }: { retention?: boolean; credits?: number } = {}
) {
  const home = mkdtempSync(join(tmpdir(), 'hermes-overlay-ownership-'))
  const previous = process.env['HERMES_HOME']
  process.env['HERMES_HOME'] = home

  const input = new EventEmitter()
  const peer = new Peer()
  const tern = new Session(input, { write: bytes => peer.write(bytes) }, { exitHooks: false, record: '' })
  const hello = tern.handshake()
  input.emit('data', '\x1b_tsp;r;' + JSON.stringify({
    ...tern.caps, r: 'hello', v: 1, term: 'strict-peer', ver: '0',
    features: retention ? ['settle'] : [], credits, apc: 1048576
  }) + '\x1b\\')

  let app: App | undefined
  let running: Promise<number> | undefined

  try {
    expect(await hello).toBe(true)
    const gw = new FakeGateway({
      replies: {
        'setup.status': () => ({ provider_configured: true }),
        'session.create': () => ({ session_id: 's1', subscription_id: 'sub1' })
      }
    })
    app = new App(tern, gw.client, 'test', { launch: readLaunchEnv({ HOME: home, HERMES_HOME: home }, home) })
    running = app.run()
    gw.event({ type: 'gateway.ready', payload: {} })
    await painted()
    const surface = tern.surfaces[0]

    if (!surface) {
      throw new Error('expected a real Tern surface')
    }

    await check({
      app, gw, peer, surface,
      event: async body => {
        input.emit('data', '\x1b_tsp;e;' + JSON.stringify(body) + '\x1b\\')
        await painted()
      }
    })
  } finally {
    app?.quit()
    if (running) {
      await running
    } else {
      await tern.close()
    }
    if (previous === undefined) {
      delete process.env['HERMES_HOME']
    } else {
      process.env['HERMES_HOME'] = previous
    }
    rmSync(home, { recursive: true, force: true })
  }
}

function approval(id: string) {
  const replies: unknown[] = []
  const req: ServerRequest = {
    id, method: 'approval',
    params: { command: 'printf fixture', request_id: `approval-${id}`, session_id: 's1' },
    fail: () => { throw new Error('Unexpected approval failure') },
    respond: value => { replies.push(value) }
  }

  return { req, replies }
}

function root(h: Harness): string {
  const top = h.app.overlays.at(-1)

  if (!top) {
    throw new Error('expected an open overlay')
  }

  return h.app.stores.stack.rootOf(top)
}

function click(h: Harness, id: string) {
  return { ev: 'action', sf: h.surface.id, id, act: 'click', raw: {} } as const
}

function denyId(rootId: string) {
  return `${rootId}.body.actions.deny`
}

function deny(h: Harness, rootId: string) {
  const event = click(h, denyId(rootId))
  const handler = h.surface.dispatch(event)

  expect(handler, 'real SDK deny handler').toBeTypeOf('function')

  return handler
}

function checkedView(h: Harness, rootId: string, actionId: string) {
  const overlay = h.app.overlays.at(-1)

  if (!overlay) {
    throw new Error('expected current overlay')
  }

  // The real SDK assigns native ids from each node's key; no synthetic map.
  const view = View.from({ layer: [overlay.node(rootId)] })
  expect(view.find(rootId)).toBeDefined()
  expect(view.find(actionId)).toBeDefined()
  expect(h.peer.documents.get(h.surface.id)?.has(actionId)).toBe(true)
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('overlay open-instance native ownership', () => {
  it('uses the real SDK latest view before native paint without reusing an old root', async () => {
    const sent: number[] = []
    let old = 0
    let current = 0
    const surface = new Surface({
      send: message => {
        if (message.verb === 'f') {
          sent.push(message.body.s)
        }
      },
      credits: () => 1,
      dropped: () => undefined
    }, 'pending-frame', { listen: true })

    surface.render({ layer: [node('row', { key: 'overlay-1', onClick: () => { old++ } })] })
    expect(sent).toHaveLength(1)
    surface.render({ layer: [node('row', { key: 'overlay-2', onClick: () => { current++ } })] })
    expect(sent).toHaveLength(1) // the second view is only queued; the native peer has not painted it

    const former = { ev: 'action', sf: surface.id, id: 'layer.overlay-1', act: 'click', raw: {} } as const
    const latest = { ...former, id: 'layer.overlay-2' }
    expect(surface.dispatch(former)).toBeUndefined() // SDK #latest already changed before paint
    await surface.dispatch(latest)?.()
    expect(old).toBe(0)
    expect(current).toBe(1)
undefined  })

  it.each([true, false])('rejects a painted old ID after same-key replacement, including the non-retention SDK writer (settle=%s)', async retention => {
    await withApp(async h => {
      const first = approval('same')
      h.gw.emit('request', first.req)
      await painted()
      const oldRoot = root(h)
      checkedView(h, oldRoot, denyId(oldRoot))
      const oldNative = click(h, denyId(oldRoot))

      const successor = approval('same')
      h.gw.emit('request', successor.req)
      await painted()
      const newRoot = root(h)

      expect(newRoot).not.toBe(oldRoot)
      expect(h.app.overlays.map(o => o.key)).toEqual(['prompt:same'])
      checkedView(h, newRoot, denyId(newRoot))
      expect(withinOverlayRoot(denyId(newRoot), oldRoot)).toBe(false)
      // Dispatch looks at the latest SDK view, never at the user's last paint.
      expect(h.surface.dispatch(oldNative)).toBeUndefined()
      expect(first.replies).toEqual([])
      expect(successor.replies).toEqual([])

      await deny(h, newRoot)?.()
      await painted()
      expect(successor.replies).toEqual([{ choice: 'deny' }])
      expect(first.replies).toEqual([])
      expect(h.app.overlays).toHaveLength(0)
    }, { retention })
  })

  it('rejects an already-bound SDK callback after replacement and responds once to the new one', async () => {
    await withApp(async h => {
      const first = approval('same')
      h.gw.emit('request', first.req)
      await painted()
      const oldRoot = root(h)
      const stale = deny(h, oldRoot)
      const next = approval('same')
      h.gw.emit('request', next.req)
      await painted()

      await stale?.()
      expect(first.replies).toEqual([])
      expect(next.replies).toEqual([])
      const latest = root(h)
      const once = deny(h, latest)
      const again = deny(h, latest)

      await once?.()
      await painted()
      await again?.()
      expect(next.replies).toEqual([{ choice: 'deny' }])
      expect(first.replies).toEqual([])
    })
  })

  it('allocates a distinct native root when the same object is replaced and reopened', async () => {
    await withApp(async h => {
      let count = 0
      const reused: Overlay = {
        key: 'reused',
        modal: true,
        node: id => node('row', { key: nativeOverlayKey(id), onClick: () => { count++ } }),
        onKey: () => true
      }

      h.app.open(reused)
      await painted()
      const first = root(h)
      const saved = h.surface.dispatch(click(h, first))
      expect(saved).toBeTypeOf('function')

      h.app.open(reused)
      await painted()
      const second = root(h)
      expect(second).not.toBe(first)
      expect(h.surface.dispatch(click(h, first))).toBeUndefined()
      await saved?.()
      expect(count).toBe(0)
      await h.surface.dispatch(click(h, second))?.()
      expect(count).toBe(1)

      h.app.close(reused)
      await painted()
      h.app.open(reused)
      await painted()
      const third = root(h)
      expect(third).not.toBe(second)
      expect(h.surface.dispatch(click(h, second))).toBeUndefined()
      await h.surface.dispatch(click(h, third))?.()
      expect(count).toBe(2)
    })
  })

  it('enforces live modal top precedence without answering a covered approval', async () => {
    await withApp(async h => {
      const lower = approval('lower')
      h.gw.emit('request', lower.req)
      await painted()
      const lowerRoot = root(h)
      const lowerCallback = deny(h, lowerRoot)
      const upper = approval('upper')
      h.gw.emit('request', upper.req)
      await painted()

      const upperRoot = root(h)
      expect(h.surface.dispatch(click(h, denyId(lowerRoot)))).toBeUndefined()
      await lowerCallback?.()
      expect(lower.replies).toEqual([])
      await deny(h, upperRoot)?.()
      await painted()
      expect(upper.replies).toEqual([{ choice: 'deny' }])
      await deny(h, lowerRoot)?.()
      await painted()
      expect(lower.replies).toEqual([{ choice: 'deny' }])
    })
  })

  it('preserves logical approval cancellation and never answers an already withdrawn request', async () => {
    await withApp(async h => {
      const pending = approval('withdrawn')
      h.gw.emit('request', pending.req)
      await painted()
      const oldRoot = root(h)
      const queued = deny(h, oldRoot)

      h.gw.event({ type: 'approval.cancelled', session_id: 's1', payload: { request_ids: ['approval-withdrawn'] } })
      await painted()
      expect(h.app.overlays).toHaveLength(0)
      expect(h.surface.dispatch(click(h, denyId(oldRoot)))).toBeUndefined()
      await queued?.()
      expect(pending.replies).toEqual([])

      const again = approval('withdrawn')
      h.gw.emit('request', again.req)
      await painted()
      const current = root(h)
      expect(current).not.toBe(oldRoot)
      await deny(h, current)?.()
      await painted()
      expect(again.replies).toEqual([{ choice: 'deny' }])
    })
  })

  it('focuses the assigned clarify input while keeping main draft, caret, scroll and ACK lifecycle intact', async () => {
    await withApp(async h => {
      h.app.stores.composer.set('unfinished draft', { cursor: 4 })
      h.app.transcript.push({ at: 1, id: entryId('keep'), kind: 'user', text: 'still here' })
      h.app.changed()
      await painted()
      const sent = h.gw.methods('prompt.submit').length
      const pending: ServerRequest = {
        id: 'clarify-1', method: 'clarify',
        params: { session_id: 's1', questions: [{ qid: 'q1', question: 'Why?' }] },
        fail: () => { throw new Error('Unexpected failure') },
        respond: () => undefined
      }

      h.gw.emit('request', pending)
      await painted()
      const id = root(h)
      const focus = `${id}.body.answer`
      expect(h.peer.documents.get(h.surface.id)?.has(focus)).toBe(true)
      expect(h.peer.frames.some(frame => frame.ops.some(op => Array.isArray(op) && op[0] === 'focus' && op[1] === focus))).toBe(true)

      // A genuine SDK credit, not a fake ACK, keeps the original frame discipline.
      await h.event({ ev: 'ack', sf: h.surface.id, s: h.surface.seq })
      h.app.scroll('main.keep', 'line-down')
      await painted()
      expect(h.peer.frames.some(frame => frame.ops.some(op => Array.isArray(op) && op[0] === 'scroll' && op[1] === 'main.keep'))).toBe(true)

      h.gw.event({ type: 'request.cancel', session_id: 's1', payload: { id: 'clarify-1' } })
      await painted()
      expect(h.app.overlays).toHaveLength(0)
      expect(h.app.stores.composer.text).toBe('unfinished draft')
      expect(h.app.stores.composer.cursor).toBe(4)
      expect(h.peer.documents.get(h.surface.id)?.has(INPUT_ID)).toBe(true)
      expect(h.peer.documents.get(h.surface.id)?.has('main.keep')).toBe(true)
      expect(h.gw.methods('prompt.submit')).toHaveLength(sent)

      const outside: TspEvent = { ev: 'focus', sf: h.surface.id, id: INPUT_ID, raw: {} }
      expect(h.app.stores.stack.nativeReceipt(outside)).toMatchObject({ allowed: true, root: null })
      expect(h.app.stores.stack.nativeReceipt({ ev: 'unknown', sf: h.surface.id, raw: { image: true } })).toMatchObject({ allowed: true, root: null })
    })
  })

  it('cannot activate a model in a same-key successor using an old picker ID or queued SDK callback', async () => {
    await withApp(async h => {
      h.gw.handlers.set('model.options', () => ({
        providers: [{ slug: 'p', name: 'Provider', models: ['one', 'two'], is_current: true }],
        model: 'one', provider: 'p'
      }))
      h.gw.handlers.set('session.resume', () => ({ session_id: 's1', revision: 3, execution_generation: 7 }))
      h.gw.handlers.set('session.mutate', params => params['operation'] === 'model' ? { status: 'applied', model: 'two' } : { status: 'applied' })
      const activate = (id: string) => ({ ev: 'activate', sf: h.surface.id, id, item: 'p\ttwo', raw: {} } as const)

      openModelPicker(h.app)
      await painted()
      const oldRoot = root(h)
      const oldNative = activate(oldRoot)
      const oldBound = h.surface.dispatch(oldNative)
      expect(oldBound).toBeTypeOf('function')

      openModelPicker(h.app)
      await painted()
      const nextRoot = root(h)
      expect(nextRoot).not.toBe(oldRoot)
      expect(View.from({ layer: [h.app.overlays.at(-1)?.node(nextRoot)] }).find(nextRoot)).toBeDefined()
      expect(h.surface.dispatch(oldNative)).toBeUndefined()
      const beforeStale = h.gw.sent('session.mutate')
      expect(beforeStale).toEqual([])
      expect(h.gw.sent('session.resume')).toEqual([])
      await oldBound?.()
      await painted()
      expect(h.gw.sent('session.mutate')).toEqual(beforeStale)
      expect(h.gw.sent('session.resume')).toEqual([])

      const current = h.surface.dispatch(activate(nextRoot))
      expect(current).toBeTypeOf('function')
      await current?.()
      await painted()
      const expected = [
        {
          operation: 'model', session_id: 's1', expected_revision: 3, expected_generation: 7,
          request_id: expect.any(String), payload: { model: 'two', provider: 'p' }
        },
        {
          operation: 'reasoning', session_id: 's1', expected_revision: 3, expected_generation: 7,
          request_id: expect.any(String), payload: { effort: 'medium' }
        }
      ]
      expect(h.gw.sent('session.mutate')).toEqual(expected)
      expect(new Set(h.gw.sent('session.mutate').map(params => params['request_id'])).size).toBe(2)
      expect(h.gw.sent('session.resume')).toEqual([{ session_id: 's1' }, { session_id: 's1' }])
      expect(h.surface.dispatch(activate(nextRoot))).toBeUndefined()
      await current?.()
      await oldBound?.()
      await painted()
      expect(h.gw.sent('session.mutate')).toEqual(expected)
      expect(h.gw.sent('session.resume')).toEqual([{ session_id: 's1' }, { session_id: 's1' }])
      expect(h.gw.sent('config.set')).toEqual([{ key: 'show_reasoning', session_id: 's1', value: 'on' }])
      expect(h.gw.methods('prompt.submit')).toHaveLength(0)
    })
  })

  it('does not submit a same-request clarify question through a stale native button', async () => {
    await withApp(async h => {
      const request = () => {
        const answers: unknown[] = []
        const req: ServerRequest = {
          id: 'clarify-same', method: 'clarify',
          params: { session_id: 's1', questions: [{ qid: 'q', question: 'Proceed?', choices: ['Yes', 'No'] }] },
          fail: () => { throw new Error('Unexpected clarify failure') },
          respond: value => { answers.push(value) }
        }

        return { req, answers }
      }

      const first = request()
      h.gw.emit('request', first.req)
      await painted()
      const oldRoot = root(h)
      const oldEvent = click(h, `${oldRoot}.body.actions.submit`)
      const oldBound = h.surface.dispatch(oldEvent)
      expect(oldBound).toBeTypeOf('function')

      const next = request()
      h.gw.emit('request', next.req)
      await painted()
      const newRoot = root(h)
      expect(newRoot).not.toBe(oldRoot)
      expect(h.surface.dispatch(oldEvent)).toBeUndefined()
      await oldBound?.()
      expect(first.answers).toEqual([])
      expect(next.answers).toEqual([])

      const newEvent = click(h, `${newRoot}.body.actions.submit`)
      const current = h.surface.dispatch(newEvent)
      expect(current).toBeTypeOf('function')
      await current?.()
      await painted()
      expect(next.answers).toEqual([{ answers: { q: 'Yes' } }])
      expect(first.answers).toEqual([])
    })
  })

  it('ignores native edits and skip clicks while a clarify answer is in flight', async () => {
    await withApp(async h => {
      const replies: PromiseWithResolvers<unknown>[] = []
      const answers: unknown[] = []
      const req: ServerRequest = {
        id: 'clarify-pending', method: 'clarify',
        params: { session_id: 's1', questions: [{ qid: 'q', question: 'Why?' }] },
        fail: () => { throw new Error('Unexpected clarify failure') },
        respond: value => {
          answers.push(value)
          const reply = Promise.withResolvers<unknown>()
          replies.push(reply)
          return reply.promise
        }
      }

      h.gw.emit('request', req)
      await painted()
      const id = root(h)
      const input = `${id}.body.answer`
      await h.event({ ev: 'edit', sf: h.surface.id, id: input, from: 0, to: 0, text: 'A', cursor: 1, len: 0 })
      await h.event(click(h, `${id}.body.actions.submit`))
      expect(answers).toEqual([{ answers: { q: 'A' } }])

      await h.event({ ev: 'edit', sf: h.surface.id, id: input, from: 1, to: 1, text: 'B', cursor: 2, len: 1 })
      await h.event(click(h, `${id}.body.actions.skip`))
      expect(answers).toHaveLength(1)
      must(replies[0]).reject(new Error('gateway unavailable'))
      await painted()
      await h.event(click(h, `${id}.body.actions.submit`))
      expect(answers).toEqual([{ answers: { q: 'A' } }, { answers: { q: 'A' } }])
      must(replies[1]).resolve({})
      await painted()
    })
  })

  it('ignores native selection and activation while a clarify choice is in flight', async () => {
    await withApp(async h => {
      const replies: PromiseWithResolvers<unknown>[] = []
      const answers: unknown[] = []
      const req: ServerRequest = {
        id: 'clarify-choice-pending', method: 'clarify',
        params: { session_id: 's1', questions: [{ qid: 'q', question: 'Which?', choices: ['A', 'B'] }] },
        fail: () => { throw new Error('Unexpected clarify failure') },
        respond: value => {
          answers.push(value)
          const reply = Promise.withResolvers<unknown>()
          replies.push(reply)
          return reply.promise
        }
      }

      h.gw.emit('request', req)
      await painted()
      const id = root(h)
      await h.event(click(h, `${id}.body.actions.submit`))
      expect(answers).toEqual([{ answers: { q: 'A' } }])
      const list = `${id}.body.q0`
      const item = `${list}.option:1`
      const select = { ev: 'select', sf: h.surface.id, id: list, item, raw: {} } as const
      const activate = { ev: 'activate', sf: h.surface.id, id: list, item, raw: {} } as const
      expect(h.surface.dispatch(select)).toBeTypeOf('function')
      expect(h.surface.dispatch(activate)).toBeTypeOf('function')
      await h.event(select)
      await h.event(activate)
      expect(answers).toHaveLength(1)

      must(replies[0]).reject(new Error('gateway unavailable'))
      await painted()
      await h.event(click(h, `${id}.body.actions.submit`))
      expect(answers).toEqual([{ answers: { q: 'A' } }, { answers: { q: 'A' } }])
      must(replies[1]).resolve({})
      await painted()
    })
  })

  it('compares native roots on exact boundaries and preserves non-native events', async () => {
    await withApp(async h => {
      const overlay: Overlay = { key: 'test', node: id => node('col', { key: nativeOverlayKey(id) }), onKey: () => true }
      for (let i = 0; i < 10; i++) {
        h.app.open(overlay)
      }
      await painted()
      const last = root(h)
      expect(last).toBe('layer.overlay-10')
      expect(withinOverlayRoot(last, 'layer.overlay-1')).toBe(false)
      expect(withinOverlayRoot(last + '.entry', last)).toBe(true)
      expect(h.app.stores.stack.nativeReceipt(click(h, 'layer.overlay-1'))).toMatchObject({ allowed: false })
      expect(h.app.stores.stack.nativeReceipt(click(h, 'layer.overlay-10.entry'))).toMatchObject({ allowed: true, root: last })
      expect(h.app.stores.stack.nativeReceipt({ ev: 'unknown', sf: h.surface.id, raw: { image: true } })).toMatchObject({ allowed: true })
    })
  })
})
