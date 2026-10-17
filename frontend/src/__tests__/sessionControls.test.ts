import { describe, expect, it } from 'vitest'

import type { App } from '../app.js'
import { localCommand } from '../commands.js'
import { compressPayload, compressReport } from '../hermes/compress.js'
import { modelPayload, mutateSession } from '../hermes/mutate.js'
import { pickerValue } from '../overlays/models.js'

/** A gateway that answers each method from `answers` and records the calls. */
function fakeGateway(answers: Record<string, unknown>) {
  const calls: [string, Record<string, unknown>][] = []

  return {
    calls,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push([method, params])

      return answers[method] as never
    }
  }
}

describe('/compress', () => {
  it('sends the raw argument as focus, as Ink does', () => {
    expect(compressPayload('')).toEqual({})
    expect(compressPayload(' here 4 ')).toEqual({ focus: 'here 4' })
    expect(compressPayload('--preview')).toEqual({ focus: '--preview' })
  })

  it('goes through session.mutate compress at the current revision', async () => {
    const gw = fakeGateway({
      'session.mutate': { status: 'applied', summary: { headline: 'Compressed: 40 → 8 messages' } },
      'session.resume': { execution_generation: 3, revision: 7 }
    })

    await mutateSession(gw, 's1', 'compress', compressPayload('auth flow'))
    expect(gw.calls.at(-1)).toEqual([
      'session.mutate',
      expect.objectContaining({
        expected_generation: 3,
        expected_revision: 7,
        operation: 'compress',
        payload: { focus: 'auth flow' },
        session_id: 's1'
      })
    ])
  })

  it('reports a commit, a no-op and a preview as the native /compress prints them', () => {
    expect(
      compressReport({
        status: 'applied',
        summary: { headline: 'Compressed: 40 → 8 messages', note: 'Kept the last 2', token_line: '~50,000 → ~9,000 tokens' }
      })
    ).toEqual({
      committed: true,
      lines: [
        { text: '✓ Compressed: 40 → 8 messages', tone: 'success' },
        { text: '  ~50,000 → ~9,000 tokens', tone: 'info' },
        { text: '  Kept the last 2', tone: 'info' }
      ]
    })
    expect(compressReport({ status: 'noop', summary: { headline: 'No changes from compression: 3 messages' } })).toEqual({
      committed: false,
      lines: [{ text: 'No changes from compression: 3 messages', tone: 'info' }]
    })
    expect(compressReport({ lines: ['Would compress 30 messages', 'Keeps 2'], status: 'preview' })).toEqual({
      committed: false,
      lines: [],
      preview: 'Would compress 30 messages\nKeeps 2'
    })
  })

  it('is a local command, so slash.exec (which refuses it) never sees it', async () => {
    let arg: string | undefined
    const app = { compress: async (a: string) => void (arg = a) } as unknown as App

    expect(localCommand('compress')).toBeDefined()
    await localCommand('compress')!.run(app, 'here 3')
    expect(arg).toBe('here 3')
  })
})

describe('/skin', () => {
  const host = (theme: string, answers: Record<string, unknown>) => {
    const gw = fakeGateway(answers)
    const notices: string[] = []
    const app = { gw, theme, transcript: { notice: (text: string) => notices.push(text) } } as unknown as App

    return { app, gw, notices }
  }

  it('reads the skin with config.get', async () => {
    const { app, gw, notices } = host('skin', { 'config.get': { value: 'ares' } })

    await localCommand('skin')!.run(app, '')
    expect(gw.calls).toEqual([['config.get', { key: 'skin' }]])
    expect(notices).toEqual(['skin: ares'])
  })

  it('sets the skin with config.set, and points at /theme skin outside the skin theme', async () => {
    const { app, gw, notices } = host('tern', { 'config.set': { key: 'skin', value: 'mono' } })

    await localCommand('skin')!.run(app, 'mono')
    expect(gw.calls).toEqual([['config.set', { key: 'skin', value: 'mono' }]])
    expect(notices).toEqual(['skin → mono', 'Hermes wears the skin in the skin theme: /theme skin'])
  })
})

describe('the model picker on the shared gateway', () => {
  it('sends a session switch the model mutation takes', () => {
    expect(modelPayload(pickerValue('hermes-4', 'nous', false))).toEqual({ model: 'hermes-4', provider: 'nous' })
  })

  it('refuses --global before any call, and says why', () => {
    expect(() => modelPayload(pickerValue('hermes-4', 'nous', true))).toThrow(/this session only/)
  })
})
