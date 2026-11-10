// Real App -> gateway event -> dock -> pinned Tern Session/Surface.dispatch regressions.
// Completions never enter the main transcript; actions are bound to a completed thread.
import { type JSX, Node } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { App } from '../app/chat.js'
import type { BtwThread } from '../wire/side.js'

import { nativeBrowserSurface } from './browserSdk.js'
import { FakeGateway, fakeTern, given, must, settle, stubOverlay, topNodes } from './fakes.js'

vi.mock('@hermes/shared/prompt-history', () => ({ append: () => undefined, load: () => [] }))

function thread(id: string, state: BtwThread['turns'][number]['state'] = 'answered', revision = 1): BtwThread {
  return {
    id,
    revision,
    turns: [{ id: id + '-turn', question: 'Question ' + id, answer: 'Answer ' + id, state }]
  }
}

function walk(nodes: readonly JSX.Element[]): Node[] {
  return nodes.flatMap(n => (n instanceof Node ? [n, ...walk(n.children)] : []))
}

type Fixture = Awaited<ReturnType<typeof appFixture>>

function row(f: Fixture) {
  const nodes = walk(topNodes(f.tern.region('dock')))

  return must(nodes.find(n => n.props['role'] === 'omp.btw.notice'), 'a native BTW dock notice')
}

async function appFixture(initial: BtwThread[] = [thread('one'), thread('two')]) {
  const gw = new FakeGateway({ replies: { 'hermes-tern.btw.list': () => ({ threads: initial }) } })
  const tern = fakeTern({ draws: true })
  const app = new App(tern.session, gw.client, 'test')
  const running = app.run()

  given.session(app, 's1')
  await app.btw.show()
  app.btw.close()
  await settle(gw)

  return {
    app,
    gw,
    tern,
    close: async () => {
      app.quit()
      tern.end()
      await running
    }
  }
}

function complete(f: Fixture, id: string, sid = 's1', text = 'Answered 🦉') {
  f.gw.event({ type: 'btw.complete', session_id: sid, payload: { task_id: id, question: 'untrusted question', text } })
}

async function sdkAction(f: Fixture, key: 'view' | 'dismiss') {
  const sdk = await nativeBrowserSurface()
  const click = sdk.capture(sdk.render('main', row(f)), 'main', key)

  return { sdk, click }
}

describe('BTW completion notice: real App -> event -> Tern dock', () => {
  it('routes a real typed completion only to the dock, then View opens exactly the completed thread without touching drafts', async () => {
    const f = await appFixture()
    f.gw.handlers.set('image.attach_bytes', () => ({ path: '/gateway/unsent.png' }))
    const imageName = 'unsent.png'
    let sdk: Awaited<ReturnType<typeof nativeBrowserSurface>> | undefined

    try {
      f.app.stores.composer.set('Main draft 🦉', { cursor: 4 })
      await f.app.stores.attachments.fromDataUrl('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=', imageName)
      const image = must(f.app.stores.attachments.items[0])
      f.app.btw.select('one')
      f.app.btw.draft.set('One side draft 🦉', { cursor: 3 })
      f.app.btw.select('two')
      f.app.btw.draft.set('Two side draft 🦉', { cursor: 5 })
      const entries = [...f.app.transcript.entries]
      const previous = f.app.btw.selected

      complete(f, 'one-turn')
      await settle(f.gw)

      expect(previous).toBe('two')
      expect(f.app.btw.notices).toMatchObject([{ id: 'btw:one', threadId: 'one', taskId: 'one-turn', sid: 's1' }])
      expect(walk(topNodes(f.tern.region('dock'))).filter(n => n.props['role'] === 'omp.btw.notice')).toHaveLength(1)
      expect(f.app.transcript.entries).toEqual(entries)

      const native = await sdkAction(f, 'view')
      sdk = native.sdk
      await native.click()
      await settle(f.gw)

      expect(f.app.btw.selected).toBe('one')
      expect(f.app.overlays.map(item => item.key)).toEqual(['btw'])
      expect(f.app.stores.composer.text).toBe('Main draft 🦉')
      expect(f.app.stores.composer.cursor).toBe(4)
      expect(f.app.stores.attachments.items).toEqual([image])
      expect(f.app.btw.draft.text).toBe('One side draft 🦉')
      expect(f.app.btw.draft.cursor).toBe(3)
      f.app.btw.select('two')
      expect(f.app.btw.draft.text).toBe('Two side draft 🦉')
      expect(f.app.btw.draft.cursor).toBe(5)
      expect(f.app.transcript.entries).toEqual(entries)
      expect(f.gw.methods('prompt.submit')).toEqual([])
      expect(f.gw.methods('prompt.btw')).toEqual([])
      expect(f.gw.sent('hermes-tern.btw.list')).toEqual([{ session_id: 's1' }, { session_id: 's1' }])
    } finally {
      await sdk?.close()
      await f.close()
    }
  })

  it('a pinned SDK Dismiss revokes queued View; duplicate completions do not resurrect the dismissed notice', async () => {
    const f = await appFixture()
    let sdk: Awaited<ReturnType<typeof nativeBrowserSurface>> | undefined

    try {
      complete(f, 'one-turn')
      await settle(f.gw)
      sdk = await nativeBrowserSurface()
      const native = sdk.render('main', row(f))
      const view = sdk.capture(native, 'main', 'view')
      const dismiss = sdk.capture(native, 'main', 'dismiss')

      await dismiss()
      await view()
      expect(f.app.btw.notices).toEqual([])
      expect(f.app.overlays).toEqual([])
      complete(f, 'one-turn')
      await settle(f.gw)
      expect(f.app.btw.notices).toEqual([])
      expect(f.app.transcript.entries.some(entry => entry.kind === 'panel')).toBe(false)
    } finally {
      await sdk?.close()
      await f.close()
    }
  })

  it('stale SDK View is refused after selection, overlay close/replacement, approval, and same-id re-adoption', async () => {
    const f = await appFixture()
    let sdk: Awaited<ReturnType<typeof nativeBrowserSurface>> | undefined

    try {
      complete(f, 'one-turn')
      await settle(f.gw)
      sdk = await nativeBrowserSurface()
      const capturedNotice = f.app.btw.notices
      expect(capturedNotice).toMatchObject([{ threadId: 'one', turnId: 'one-turn', sid: 's1' }])
      expect(f.app.btw.selected).toBe('two')
      const oldSelection = sdk.capture(sdk.render('main', row(f)), 'main', 'view')
      f.app.btw.select('one') // a different known thread invalidates the rendered action
      expect(f.app.btw.selected).toBe('one')
      await oldSelection()
      expect(f.app.overlays).toEqual([])
      f.app.btw.select('two') // ABA: restoring the old selection must not revive it
      expect(f.app.btw.selected).toBe('two')
      await oldSelection()
      expect(f.app.overlays).toEqual([])

      await settle(f.gw)
      const underApproval = sdk.capture(sdk.render('main', row(f)), 'main', 'view')
      const approval = stubOverlay('approval', { modal: true })
      f.app.open(approval)
      await underApproval()
      expect(f.app.overlays).toEqual([approval])
      f.app.close(approval)
      // The intervening modal's close must not reactivate the pre-approval callback.
      await underApproval()
      expect(f.app.overlays).toEqual([])

      await settle(f.gw)
      const beforeClose = sdk.capture(sdk.render('main', row(f)), 'main', 'view')
      await beforeClose()
      await settle(f.gw)
      expect(f.app.overlays.map(o => o.key)).toEqual(['btw'])
      f.app.btw.close()
      await beforeClose()
      expect(f.app.overlays).toEqual([])

      await settle(f.gw)
      const sameSid = sdk.capture(sdk.render('main', row(f)), 'main', 'view')
      given.session(f.app, 's1')
      f.app.btw.adopt('s1')
      await sameSid()
      expect(f.app.overlays).toEqual([])
      expect(f.app.btw.notices).toEqual([])
    } finally {
      await sdk?.close()
      await f.close()
    }
  })

  it('pending completions bind only after an exact thread or turn ID arrives; foreign and ambiguous IDs never open a thread', async () => {
    const f = await appFixture([])
    let sdk: Awaited<ReturnType<typeof nativeBrowserSurface>> | undefined

    try {
      const entries = [...f.app.transcript.entries]
      complete(f, 'later-turn')
      complete(f, 'foreign-turn', 'other')
      await settle(f.gw)
      expect(f.app.btw.notices).toEqual([])
      f.gw.event({ type: 'btw.update', session_id: 's1', payload: { thread: thread('later') } })
      await settle(f.gw)
      expect(f.app.btw.notices).toMatchObject([{ id: 'btw:later', threadId: 'later' }])

      f.gw.event({ type: 'btw.update', session_id: 's1', payload: { thread: {
        ...thread('a'), turns: [{ ...must(thread('a').turns[0]), id: 'ambiguous-turn' }]
      } } })
      f.gw.event({ type: 'btw.update', session_id: 's1', payload: { thread: {
        ...thread('b'), turns: [{ ...must(thread('b').turns[0]), id: 'ambiguous-turn' }]
      } } })
      await settle(f.gw)
      // Both terminal updates are legitimate, despite their colliding turn IDs.
      // Only the legacy typed completion is ambiguous; it must not bind either.
      const terminalNotices = f.app.btw.notices
      expect(terminalNotices.map(({ id, taskId, threadId, turnId, failed }) => ({
        id, taskId, threadId, turnId, failed
      }))).toEqual([
        { id: 'btw:later', taskId: 'later-turn', threadId: 'later', turnId: 'later-turn', failed: false },
        { id: 'btw:a', taskId: 'ambiguous-turn', threadId: 'a', turnId: 'ambiguous-turn', failed: false },
        { id: 'btw:b', taskId: 'ambiguous-turn', threadId: 'b', turnId: 'ambiguous-turn', failed: false }
      ])
      const lists = f.gw.sent('hermes-tern.btw.list')
      complete(f, 'ambiguous-turn')
      await settle(f.gw)
      expect(f.app.btw.notices).toEqual(terminalNotices) // includes the captured nonces and tickets
      expect(f.app.overlays).toEqual([]) // no View from an ambiguous task
      expect(f.gw.sent('hermes-tern.btw.list')).toEqual(lists)
      expect(walk(topNodes(f.tern.region('dock'))).filter(n => n.props['role'] === 'omp.btw.notice')).toHaveLength(3)

      sdk = await nativeBrowserSurface()
      const view = sdk.capture(sdk.render('main', row(f)), 'main', 'view')
      await view()
      await settle(f.gw)
      expect(f.app.btw.selected).toBe('later')
      expect(f.app.transcript.entries).toEqual(entries)
      expect(f.gw.methods('prompt.submit')).toEqual([])
    } finally {
      await sdk?.close()
      await f.close()
    }
  })

  it('a late completion for an older turn cannot claim a newer completed follow-up', async () => {
    const multi: BtwThread = {
      id: 'multi',
      revision: 3,
      turns: [
        { id: 'old-turn', question: 'Old', answer: 'Old answer', state: 'answered' },
        { id: 'new-turn', question: 'New', answer: 'New answer', state: 'answered' }
      ]
    }
    const f = await appFixture([multi])

    try {
      complete(f, 'old-turn')
      await settle(f.gw)
      expect(f.app.btw.notices).toEqual([])
      complete(f, 'new-turn')
      await settle(f.gw)
      expect(f.app.btw.notices).toMatchObject([{ threadId: 'multi', turnId: 'new-turn' }])
      expect(f.app.overlays).toEqual([])
    } finally {
      await f.close()
    }
  })

  it('waits for an actual terminal turn before binding an already-identified typed completion', async () => {
    const f = await appFixture([thread('running', 'running')])

    try {
      const before = [...f.app.transcript.entries]
      complete(f, 'running-turn', 's1', 'error: real worker failure')
      await settle(f.gw)
      expect(f.app.btw.notices).toEqual([])

      f.gw.event({ type: 'btw.update', session_id: 's1', payload: { thread: thread('running', 'answered', 2) } })
      await settle(f.gw)
      expect(f.app.btw.notices).toMatchObject([{ threadId: 'running', turnId: 'running-turn', failed: true }])
      expect(f.app.transcript.entries).toEqual(before)
    } finally {
      await f.close()
    }
  })

  it('projects real terminal btw.update into an exact-thread View, without a legacy completion or duplicate notices', async () => {
    const f = await appFixture([])
    let sdk: Awaited<ReturnType<typeof nativeBrowserSurface>> | undefined

    try {
      const before = [...f.app.transcript.entries]
      f.gw.event({ type: 'btw.update', session_id: 's1', payload: { thread: thread('native') } })
      await settle(f.gw)
      expect(f.app.btw.notices).toMatchObject([{ id: 'btw:native', threadId: 'native', turnId: 'native-turn' }])
      sdk = await nativeBrowserSurface()
      const notice = sdk.render('main', row(f))
      const dismiss = sdk.capture(notice, 'main', 'dismiss')
      const stale = sdk.capture(notice, 'main', 'view')
      await dismiss()
      await stale()
      expect(f.app.overlays).toEqual([])
      expect(f.app.btw.notices).toEqual([])

      // Replayed or revised copies of the same terminal turn must not undo dismissal.
      f.gw.event({ type: 'btw.update', session_id: 's1', payload: { thread: thread('native', 'answered', 2) } })
      complete(f, 'native-turn')
      await settle(f.gw)
      expect(f.app.btw.notices).toEqual([])

      const next = { ...thread('native', 'answered', 3), turns: [
        ...thread('native').turns,
        { id: 'next-turn', question: 'Follow-up 🦉', answer: 'Ready', state: 'answered' as const }
      ] }
      f.gw.event({ type: 'btw.update', session_id: 's1', payload: { thread: next } })
      await settle(f.gw)
      expect(f.app.btw.notices).toMatchObject([{ id: 'btw:native', turnId: 'next-turn' }])
      const view = sdk.capture(sdk.render('main', row(f)), 'main', 'view')
      await view()
      await settle(f.gw)
      expect(f.app.btw.selected).toBe('native')
      expect(f.app.transcript.entries).toEqual(before)
    } finally {
      await sdk?.close()
      await f.close()
    }
  })

  it('preserves existing background completion panels without allowing BTW Q/A panels into main history', async () => {
    const f = await appFixture()

    try {
      const before = [...f.app.transcript.entries]
      complete(f, 'one-turn')
      await settle(f.gw)
      expect(f.app.transcript.entries).toEqual(before)

      f.gw.event({ type: 'background.complete', session_id: 's1', payload: { task_id: 'bg-1', text: 'Real background result' } })
      await settle(f.gw)
      expect(f.app.transcript.entries.slice(before.length)).toMatchObject([
        { kind: 'panel', title: 'Background task bg-1' }
      ])
      expect(f.app.btw.notices).toHaveLength(1)
    } finally {
      await f.close()
    }
  })

  it('an old SDK View cannot resurrect a removed notice after a different session takes ownership', async () => {
    const f = await appFixture()
    let sdk: Awaited<ReturnType<typeof nativeBrowserSurface>> | undefined

    try {
      complete(f, 'one-turn')
      await settle(f.gw)
      sdk = await nativeBrowserSurface()
      const view = sdk.capture(sdk.render('main', row(f)), 'main', 'view')
      given.session(f.app, 's2')
      f.app.btw.adopt('s2')
      await view()
      expect(f.app.btw.notices).toEqual([])
      expect(f.app.overlays).toEqual([])
      expect(f.gw.sent('hermes-tern.btw.list')).toEqual([{ session_id: 's1' }])
    } finally {
      await sdk?.close()
      await f.close()
    }
  })
})
