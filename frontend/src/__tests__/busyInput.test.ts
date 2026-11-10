import { afterEach, describe, expect, it, vi } from 'vitest'

import { busy, settle, setup } from './appSetup.js'
import { given, key, stubOverlay } from './fakes.js'

vi.mock('@hermes/shared/prompt-history', () => ({ append: () => undefined, load: () => [] }))
afterEach(() => vi.useRealTimers())

const altEnter = key('enter', { alt: true })
const requestHandlers = {
  'session.resume': () => ({ execution_generation: 7 })
}

describe('explicit busy input over the existing queue', () => {
  it('keeps plain Enter as queue and Alt+Enter as a live correction', async () => {
    const f = setup({ ...requestHandlers, 'session.steer': () => ({ status: 'queued' }) })
    given.busy(f.app.stores, { ...busy })
    f.app.transcript.messageStart()

    await f.type('next task')
    await f.press(key('enter'))
    expect(f.sent('prompt.submit')[0]).toMatchObject({ queued: true, text: 'next task' })
    expect(f.sent('session.steer')).toEqual([])

    await f.type('use the smaller scope')
    await f.press(altEnter)
    await vi.waitFor(() => expect(f.sent('session.steer')).toHaveLength(1))
    expect(f.sent('session.steer')[0]).toMatchObject({ execution_generation: 7, session_id: 's1', text: 'use the smaller scope' })
    expect(f.app.stores.composer.text).toBe('')
    expect(f.app.transcript.live?.blocks).toContainEqual(expect.objectContaining({ kind: 'steer', text: 'use the smaller scope' }))
  })

  it('reverses busy Enter and Alt+Enter when the user selects steer mode', async () => {
    const f = setup({ ...requestHandlers, 'session.steer': () => ({ status: 'queued' }) })
    f.app.session.busyMode = 'steer'
    given.busy(f.app.stores, { ...busy })
    f.app.transcript.messageStart()

    await f.type('fix this')
    await f.press(key('enter'))
    await vi.waitFor(() => expect(f.sent('session.steer')).toHaveLength(1))
    expect(f.sent('prompt.submit')).toEqual([])

    await f.type('run next')
    await f.press(altEnter)
    await vi.waitFor(() => expect(f.sent('prompt.submit')).toHaveLength(1))
    expect(f.sent('prompt.submit')[0]).toMatchObject({ queued: true, text: 'run next' })
    expect(f.sent('session.steer')).toHaveLength(1)
  })

  it('retains refused correction verbatim, including its caret', async () => {
    const f = setup({ ...requestHandlers, 'session.steer': () => ({ status: 'rejected' }) })
    given.busy(f.app.stores, { ...busy })
    f.app.transcript.messageStart()
    f.app.stores.composer.set('keep this draft', { cursor: 4 })

    await f.press(altEnter)
    await vi.waitFor(() => expect(f.sent('session.steer')).toHaveLength(1))
    await settle()

    expect(f.app.stores.composer.text).toBe('keep this draft')
    expect(f.app.stores.composer.cursor).toBe(4)
    expect(f.sent('prompt.submit')).toEqual([])
    expect(f.app.transcript.entries.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('rejected') })
  })

  it('coalesces repeat corrections and does not erase a newer draft on late success', async () => {
    const response = Promise.withResolvers<{ status: string }>()
    const f = setup({ ...requestHandlers, 'session.steer': () => response.promise })
    given.busy(f.app.stores, { ...busy })
    f.app.transcript.messageStart()
    f.app.stores.composer.set('old draft', { cursor: 3 })

    await f.press(altEnter)
    await vi.waitFor(() => expect(f.sent('session.steer')).toHaveLength(1))
    await f.press(altEnter)
    f.app.stores.composer.set('new draft', { cursor: 2 })
    response.resolve({ status: 'queued' })
    await settle()

    expect(f.sent('session.steer')).toHaveLength(1)
    expect(f.app.stores.composer.text).toBe('new draft')
    expect(f.app.stores.composer.cursor).toBe(2)
    expect(f.app.transcript.live?.blocks).toContainEqual(expect.objectContaining({ kind: 'steer', text: 'old draft' }))
  })

  it('drops stale confirmation when a new session takes the pane', async () => {
    const response = Promise.withResolvers<{ status: string }>()
    const f = setup({ ...requestHandlers, 'session.steer': () => response.promise })
    given.busy(f.app.stores, { ...busy })
    f.app.transcript.messageStart()
    f.app.stores.composer.set('old correction')
    await f.press(altEnter)
    await vi.waitFor(() => expect(f.sent('session.steer')).toHaveLength(1))

    given.session(f.app.stores, 's2')
    f.app.transcript.reset({ session: 'other', usage: undefined })
    f.app.stores.composer.set('new session draft')
    response.resolve({ status: 'queued' })
    await settle()

    expect(f.app.stores.composer.text).toBe('new session draft')
    expect(f.app.transcript.entries.some(e => e.kind === 'turn')).toBe(false)
  })

  it('records an accepted correction for a resumed busy session without a live transcript turn', async () => {
    const f = setup({ ...requestHandlers, 'session.steer': () => ({ status: 'queued' }) })
    given.busy(f.app.stores, { ...busy })
    expect(f.app.transcript.live).toBeUndefined()
    f.app.stores.composer.set('resume correction', { cursor: 6 })

    await f.press(altEnter)
    await vi.waitFor(() => expect(f.sent('session.steer')).toHaveLength(1))

    expect(f.app.transcript.live?.blocks).toContainEqual(expect.objectContaining({ kind: 'steer', text: 'resume correction' }))
    expect(f.app.stores.composer.text).toBe('')
  })

  it('reconciles a same-ID transcript replay gap before taking an accepted draft', async () => {
    const confirmation = Promise.withResolvers<{ status: string }>()
    const f = setup({ ...requestHandlers, 'session.steer': () => confirmation.promise })
    given.busy(f.app.stores, { ...busy })
    const abandoned = f.app.transcript.messageStart()
    f.app.stores.composer.set('keep the correction')

    await f.press(altEnter)
    await vi.waitFor(() => expect(f.sent('session.steer')).toHaveLength(1))

    // Reattachment on the same runtime ID does not invalidate a SessionTicket.
    f.app.transcript.reset({ session: 'same', usage: undefined })
    f.app.transcript.load([{ role: 'user', text: 'replayed prompt' }])
    given.busy(f.app.stores, { ...busy })
    confirmation.resolve({ status: 'queued' })
    await settle()

    expect(f.app.session.ref.live).toBe('s1')
    expect(f.app.transcript.entries).not.toContain(abandoned)
    expect(f.app.transcript.live?.blocks).toContainEqual(expect.objectContaining({ kind: 'steer', text: 'keep the correction' }))
    expect(f.app.stores.composer.text).toBe('')
  })

  it('expands typed inline directives before Alt+Enter steering, but keeps pasted directives literal', async () => {
    const f = setup({
      ...requestHandlers,
      'session.steer': () => ({ status: 'queued' }),
      'shell.exec': () => ({ code: 0, stderr: '', stdout: 'clean\n' })
    })
    given.busy(f.app.stores, { ...busy })
    f.app.transcript.messageStart()
    const raw = 'Review this: {!git status}'

    f.app.stores.composer.set(raw)
    await f.press(altEnter)
    await vi.waitFor(() => expect(f.sent('session.steer')).toHaveLength(1))
    expect(f.sent('shell.exec')).toEqual([{ command: 'git status', session_id: 's1' }])
    expect(f.sent('session.steer')[0]).toMatchObject({ text: 'Review this: clean' })
    expect(f.app.transcript.live?.blocks).toContainEqual(expect.objectContaining({ kind: 'steer', text: raw }))

    f.app.stores.composer.key(key('paste', { text: raw }))
    await f.press(altEnter)
    await vi.waitFor(() => expect(f.sent('session.steer')).toHaveLength(2))
    expect(f.sent('shell.exec')).toHaveLength(1)
    expect(f.sent('session.steer')[1]).toMatchObject({ text: raw })
  })

  it('uses the same typed/pasted expansion contract when Enter is configured to steer', async () => {
    const f = setup({
      ...requestHandlers,
      'session.steer': () => ({ status: 'queued' }),
      'shell.exec': () => ({ code: 0, stderr: '', stdout: 'ok' })
    })
    f.app.session.busyMode = 'steer'
    given.busy(f.app.stores, { ...busy })
    f.app.transcript.messageStart()
    const raw = 'Check {!pwd}'

    f.app.stores.composer.set(raw)
    await f.press(key('enter'))
    await vi.waitFor(() => expect(f.sent('session.steer')).toHaveLength(1))
    expect(f.sent('session.steer')[0]).toMatchObject({ text: 'Check ok' })

    f.app.stores.composer.key(key('paste', { text: raw }))
    await f.press(key('enter'))
    await vi.waitFor(() => expect(f.sent('session.steer')).toHaveLength(2))
    expect(f.sent('shell.exec')).toHaveLength(1)
    expect(f.sent('session.steer')[1]).toMatchObject({ text: raw })
    expect(f.sent('prompt.submit')).toHaveLength(0)
  })

  it('keeps draft text, paste exclusions and caret on an expansion failure instead of restoring twice', async () => {
    const f = setup({
      ...requestHandlers,
      'shell.exec': () => {
        throw new Error('command_failed')
      }
    })
    given.busy(f.app.stores, { ...busy })
    f.app.transcript.messageStart()
    f.app.stores.composer.set('Check {!bad}', { cursor: 3 })

    await f.press(altEnter)
    await vi.waitFor(() => expect(f.sent('shell.exec')).toHaveLength(1))
    expect(f.sent('session.steer')).toHaveLength(0)
    expect(f.app.stores.composer.text).toBe('Check {!bad}')
    expect(f.app.stores.composer.cursor).toBe(3)
    expect(f.app.transcript.entries.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('Not sent') })
  })

  it('never sends an expansion result after an edit or a modal takes admission', async () => {
    const first = Promise.withResolvers<{ code: number; stderr: string; stdout: string }>()
    const second = Promise.withResolvers<{ code: number; stderr: string; stdout: string }>()
    let shell = first.promise
    const f = setup({
      ...requestHandlers,
      'shell.exec': () => shell,
      'session.steer': () => ({ status: 'queued' })
    })
    given.busy(f.app.stores, { ...busy })
    f.app.transcript.messageStart()
    f.app.stores.composer.set('First {!pwd}', { cursor: 2 })

    await f.press(altEnter)
    await vi.waitFor(() => expect(f.sent('shell.exec')).toHaveLength(1))
    f.app.stores.composer.set('a newer draft', { cursor: 4 })
    first.resolve({ code: 0, stderr: '', stdout: '/tmp' })
    await settle()
    expect(f.sent('session.steer')).toHaveLength(0)
    expect(f.app.stores.composer.text).toBe('a newer draft')
    expect(f.app.stores.composer.cursor).toBe(4)

    shell = second.promise
    f.app.stores.composer.set('Second {!pwd}', { cursor: 3 })
    await f.press(altEnter)
    await vi.waitFor(() => expect(f.sent('shell.exec')).toHaveLength(2))
    const modal = stubOverlay('prompt:approval', { modal: true })
    f.app.open(modal)
    second.resolve({ code: 0, stderr: '', stdout: '/tmp' })
    await settle()

    expect(f.sent('session.steer')).toHaveLength(0)
    expect(f.app.stores.composer.text).toBe('Second {!pwd}')
    expect(f.app.stores.composer.cursor).toBe(3)
    f.app.close(modal)
  })
})
