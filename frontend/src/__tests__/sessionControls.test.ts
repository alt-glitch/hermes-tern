import { describe, expect, it } from 'vitest'

import { type CommandHost, localCommand } from '../commands.js'
import { modelPayload } from '../hermes/mutate.js'
import { pickerValue } from '../overlays/models.js'

import { must } from './fakes.js'

/** A gateway that answers each method from `answers` and records the calls. */
function fakeGateway(answers: Record<string, unknown>) {
  const calls: [string, Record<string, unknown>][] = []

  return {
    calls,
    request: async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      calls.push([method, params])

      return answers[method]
    }
  }
}

describe('/skin', () => {
  const host = (theme: string, answers: Record<string, unknown>) => {
    const gw = fakeGateway(answers)
    const notices: string[] = []
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a stub host: /skin reaches only gw, theme and transcript.notice
    const app = { gw, theme, transcript: { notice: (text: string) => notices.push(text) } } as unknown as CommandHost

    return { app, gw, notices }
  }

  it('reads the skin with config.get', async () => {
    const { app, gw, notices } = host('skin', { 'config.get': { value: 'ares' } })

    await must(localCommand('skin')).run(app, '')
    expect(gw.calls).toEqual([['config.get', { key: 'skin' }]])
    expect(notices).toEqual(['skin: ares'])
  })

  it('sets the skin with config.set, and points at /theme skin outside the skin theme', async () => {
    const { app, gw, notices } = host('tern', { 'config.set': { key: 'skin', value: 'mono' } })

    await must(localCommand('skin')).run(app, 'mono')
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
