import { EventEmitter } from 'node:events'

import { Session } from '@stencil-hq/tern'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { transcriptContext, type FrameCx } from '../app/frame.js'
import { entryId } from '../core/ids.js'
import type { UserEntry } from '../model.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'

import { stub, tree } from './fakes.js'

const timestamp = Date.parse('2026-10-28T13:05:00Z')
const user = (): UserEntry => ({ at: timestamp, id: entryId('u'), kind: 'user', text: 'hello' })
const cx = (hour12?: boolean): TranscriptContext => ({
  copy: () => undefined, now: timestamp, welcome: { version: '' },
  ...(hour12 === undefined ? {} : { hour12 })
})
const timeString = Date.prototype.toLocaleTimeString
const dateString = Date.prototype.toLocaleString

function locale(name: string) {
  vi.spyOn(Date.prototype, 'toLocaleTimeString').mockImplementation(function (this: Date, _locales, options) {
    return timeString.call(this, name, { ...options, timeZone: 'UTC' })
  })
  vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(function (this: Date, _locales, options) {
    return dateString.call(this, name, { ...options, timeZone: 'UTC' })
  })
}

afterEach(() => vi.restoreAllMocks())

describe('negotiated transcript clock', () => {
  it('honors 24-hour time in a 12-hour locale, including the old-host default', () => {
    locale('en-US')
    expect(JSON.stringify(tree(entryNode(user(), 'main.u', cx(false))))).toContain('13:05')
    expect(JSON.stringify(tree(entryNode(user(), 'main.u', cx())))).toContain('13:05')
    expect(JSON.stringify(tree(entryNode(user(), 'main.u', cx(false))))).toContain(dateString.call(new Date(timestamp), 'en-US', { hour12: false, timeZone: 'UTC' }))
  })

  it.each([undefined, false, true])('carries SDK hello hour12=%s through frame context', async value => {
    locale('en-US')
    const input = new EventEmitter()
    const session = new Session(input, { write() {} }, { exitHooks: false, record: '', timeout: 2000 })
    const handshake = session.handshake()
    input.emit('data', `\x1b_tsp;r;${JSON.stringify({ r: 'hello', ...(value === undefined ? {} : { hour12: value }) })}\x1b\\`)
    expect(await handshake).toBe(true)
    const frame = stub<Pick<FrameCx, 'session' | 'copies' | 'welcome' | 'gateway' | 'hour12'>>({
      session: { info: null, ref: { live: null, stored: null } },
      copies: { copy: () => undefined }, welcome: { version: '' },
      hour12: () => session.caps.hour12
    })
    const view = transcriptContext(frame, timestamp)
    expect(view.hour12).toBe(value ?? false)
    expect(JSON.stringify(tree(entryNode(user(), 'main.u', view)))).toContain(value ? '01:05 PM' : '13:05')
    await session.close()
  })

  it('honors 12-hour time in a 24-hour locale', () => {
    locale('en-GB')
    expect(JSON.stringify(tree(entryNode(user(), 'main.u', cx(true))))).toMatch(/01:05\s*pm/i)
    expect(JSON.stringify(tree(entryNode(user(), 'main.u', cx(true))))).toContain(dateString.call(new Date(timestamp), 'en-GB', { hour12: true, timeZone: 'UTC' }))
  })

  it('uses the locale clock cycle at midnight and noon for either preference', () => {
    locale('en-US')
    for (const value of [false, true]) {
      for (const at of [Date.parse('2026-10-28T00:05:00Z'), Date.parse('2026-10-28T12:05:00Z')]) {
        const expected = timeString.call(new Date(at), 'en-US', { hour: '2-digit', hour12: value, minute: '2-digit', timeZone: 'UTC' })
        expect(JSON.stringify(tree(entryNode({ ...user(), at }, 'main.u', cx(value))))).toContain(expected)
      }
    }
  })

  it('reuses a user node until its effective preference changes', () => {
    locale('en-US')
    const entry = user()
    const first = entryNode(entry, 'main.u', cx(false))
    expect(entryNode(entry, 'main.u', cx())).toBe(first)
    const changed = entryNode(entry, 'main.u', cx(true))
    expect(changed).not.toBe(first)
    expect(JSON.stringify(tree(changed))).toContain('01:05 PM')
    expect(entryNode(entry, 'main.u', cx(true))).toBe(changed)
    expect(entryNode(user(), 'main.u', cx(false))).not.toBe(changed)
  })
})
