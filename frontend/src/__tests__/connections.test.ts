import { describe, expect, it } from 'vitest'

import { applyStatus, connectTargets, continueMessage, isConnectCall } from '../connections.js'
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

  it('marks an app connected when connectors.list says so, and a failed one failed', () => {
    const next = applyStatus(connectTargets(call()), [
      { connected: true, connector: 'googledrive' },
      { connected: false, connection_status: 'expired', connector: 'gmail' }
    ])

    expect(next.map(t => t.state)).toEqual(['connected', 'expired', 'connected'])
  })

  it('tells the agent which apps the user authorized', () => {
    expect(continueMessage(connectTargets(call()))).toBe(
      "I've authorized Google Drive, Gmail and Slack. Check with manage_connections status and carry on."
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
