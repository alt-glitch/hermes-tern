import { describe, expect, it } from 'vitest'

import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { connectedMessage, connectTargets, continueMessage, isConnectCall, markViewer, readCard } from '../connections.js'
import type { ToolCall, TurnEntry } from '../model.js'
import { foldOf, ownsCard } from '../workLog.js'

const result = {
  note: 'Show each connect_url to the user; they open it in a browser to authorize.',
  status: 'initiated',
  targets: [
    { action: 'connect', connect_url: 'https://portal/x?a=1', kind: 'connector', name: 'googledrive', state: 'initiated' },
    { action: 'connect', connect_url: 'https://portal/y', kind: 'connector', name: 'gmail', state: 'initiated', alias: 'work' },
    { action: 'connect', kind: 'connector', name: 'slack', state: 'connected' }
  ]
}

const call = (over: Partial<ToolCall> = {}): ToolCall => ({
  args: { action: 'connect', connectors: ['googledrive', 'gmail', 'slack'] },
  argsText: '',
  context: '',
  id: 'c1',
  name: 'manage_connections',
  result: JSON.stringify(result),
  startedAt: 0,
  status: 'done',
  ...over
})

describe('manage_connections without its card', () => {
  it('reads the apps and their links from the no-card result', () => {
    expect(connectTargets(call()).map(t => [t.title, t.state, t.url ?? '', t.alias ?? ''])).toEqual([
      ['Google Drive', 'initiated', 'https://portal/x?a=1', ''],
      ['Gmail', 'initiated', 'https://portal/y', 'work'],
      ['Slack', 'connected', '', '']
    ])
    expect(isConnectCall(call())).toBe(true)
    expect(isConnectCall(call({ result: JSON.stringify({ connectors: [] }) }))).toBe(false)
    expect(isConnectCall(call({ name: 'terminal' }))).toBe(false)
  })

  it('takes the links and live states from the watcher file when the result has none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tern-connect-'))
    mkdirSync(join(dir, 'connections'))
    writeFileSync(
      join(dir, 'connections', 'c1.json'),
      JSON.stringify({ targets: [{ connect_url: 'https://portal/x', name: 'googledrive', state: 'connected' }, { connect_url: 'https://portal/y', name: 'gmail', state: 'initiated' }], watching: true })
    )
    const stripped = call({ result: JSON.stringify({ status: 'initiated', targets: [{ name: 'googledrive', state: 'initiated' }, { name: 'gmail', state: 'initiated' }] }) })
    const card = readCard('c1', dir)

    expect(connectTargets(stripped).some(t => t.url)).toBe(false)
    expect(connectTargets(stripped, card).map(t => [t.title, t.state, t.url])).toEqual([
      ['Google Drive', 'connected', 'https://portal/x'],
      ['Gmail', 'initiated', 'https://portal/y']
    ])
    expect(card?.watching).toBe(true)
    expect(readCard('missing', dir)).toBeUndefined()
  })

  it('marks this pane as the viewer of one session at a time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tern-viewers-'))

    markViewer('s1', null, dir)
    expect(JSON.parse(readFileSync(join(dir, 'viewers', 's1.json'), 'utf8'))).toEqual({ pid: process.pid })
    markViewer('s2', 's1', dir)
    expect(existsSync(join(dir, 'viewers', 's1.json'))).toBe(false)
    expect(existsSync(join(dir, 'viewers', 's2.json'))).toBe(true)
  })

  it('tells the agent which apps the user authorized, or that all are connected', () => {
    expect(continueMessage(connectTargets(call()))).toBe(
      "I've authorized Google Drive, Gmail and Slack. Check with manage_connections status and carry on."
    )
    expect(connectedMessage(connectTargets(call()).map(t => ({ ...t, state: 'connected' })))).toBe(
      'Google Drive, Gmail and Slack are connected now. Carry on.'
    )
  })

  it('owns a card and stays out of the turn fold', () => {
    const c = call()
    const turn: TurnEntry = {
      blocks: [
        { call: c, id: 'b1', kind: 'tool' },
        { id: 'b2', kind: 'text', text: 'While you authorize those, I will start.' }
      ],
      endedAt: 1000,
      id: 't',
      kind: 'turn',
      rev: 0,
      startedAt: 0,
      status: 'done'
    }

    expect(ownsCard(c)).toBe(true)
    expect(foldOf(turn)?.hidden.has('b1') ?? false).toBe(false)
  })
})
