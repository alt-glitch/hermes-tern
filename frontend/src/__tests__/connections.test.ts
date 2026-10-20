import { describe, expect, it } from 'vitest'

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  allConnected,
  cardStem,
  claimTold,
  connectedMessage,
  connectTargets,
  continueMessage,
  findCard,
  isConnectCall,
  loadConnect,
  markViewer,
  readCard,
  STALE_MS,
  ternPane
} from '../connections.js'
import { entryId, liveSessionId, storedSessionId, toolCallId } from '../core/ids.js'
import type { ToolCall, TurnEntry } from '../model.js'
import { decodeJson } from '../wire/json.js'
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

/** A call's fields to set; its id as plain text. */
type CallOver = Omit<Partial<ToolCall>, 'id'> & { id?: string }

const call = ({ id = 'c1', ...over }: CallOver = {}): ToolCall => ({
  args: { action: 'connect', connectors: ['googledrive', 'gmail', 'slack'] },
  argsText: '',
  context: '',
  id: toolCallId(id),
  name: 'manage_connections',
  result: JSON.stringify(result),
  startedAt: 0,
  outcome: { duration: 0, kind: 'done' },
  via: { kind: 'direct' },
  ...over
})

/** A data dir whose `connections/` holds `cards` (by file stem), as the plugin's watcher writes them. */
function dataDir(cards: Record<string, Record<string, unknown>>) {
  const dir = mkdtempSync(join(tmpdir(), 'tern-connect-'))
  mkdirSync(join(dir, 'connections'))

  for (const [stem, data] of Object.entries(cards)) {
    writeFileSync(join(dir, 'connections', `${stem}.json`), JSON.stringify({ pid: process.pid, updated_at: Date.now() / 1000, ...data }))
  }

  return dir
}

const watched = (state: string, over: Record<string, unknown> = {}) => ({
  settled_by: null,
  targets: [{ connect_url: 'https://portal/x', name: 'googledrive', state }],
  watching: true,
  ...over
})

const stripped = (over: CallOver = {}) =>
  call({ result: JSON.stringify({ op_id: 'op1', status: 'initiated', targets: [{ name: 'googledrive', state: 'initiated' }] }), ...over })

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

  it('takes the links and live states from the watcher file named by the operation', () => {
    const dir = dataDir({
      'c1.op1': {
        targets: [{ connect_url: 'https://portal/x', name: 'googledrive', state: 'connected' }, { connect_url: 'https://portal/y', name: 'gmail', state: 'initiated' }],
        watching: true
      }
    })
    const c = stripped()

    expect(connectTargets(c).some(t => t.url)).toBe(false)
    expect(findCard(c, dir)).toBe('c1.op1')
    const card = loadConnect(c, dir)
    expect(card?.targets.map(t => [t.title, t.state, t.url])).toEqual([
      ['Google Drive', 'connected', 'https://portal/x'],
      ['Gmail', 'initiated', 'https://portal/y']
    ])
    expect(card).toMatchObject({ key: 'c1.op1', settled: undefined, told: false })
    expect(readCard('missing', dir)).toBeUndefined()
  })

  it('names a card by its operation: a reused call id never draws an earlier call\'s card', () => {
    const dir = dataDir({ 'call_0.op1': watched('connected'), 'call_0.op2': watched('initiated') })

    expect(findCard(stripped({ id: 'call_0', result: JSON.stringify({ op_id: 'op2', targets: [] }) }), dir)).toBe('call_0.op2')
    // An operation with no card of its own draws none, not its call id's other card.
    expect(findCard(stripped({ id: 'call_0', result: JSON.stringify({ op_id: 'op9', targets: [] }) }), dir)).toBeUndefined()
    expect(cardStem('a:b/c', 'op1')).toBe('a_b_c.op1')
  })

  it('finds a stored call\'s card by its call id, the nearest in time when the id repeats', () => {
    const dir = dataDir({
      'call_0.op1': watched('connected', { created_at: 1000 }),
      'call_0.op2': watched('initiated', { created_at: 5000 }),
      'call_01.op3': watched('initiated', { created_at: 1000 }),
      c9: watched('initiated')
    })
    // History brings the call back without its result.
    const stored = (id: string, at: number) => call({ id, result: undefined, startedAt: at * 1000 })

    expect(findCard(stored('call_0', 1001), dir)).toBe('call_0.op1')
    expect(findCard(stored('call_0', 4990), dir)).toBe('call_0.op2')
    expect(findCard(stored('call_01', 0), dir)).toBe('call_01.op3')
    // A card from before cards had an operation.
    expect(findCard(stored('c9', 0), dir)).toBe('c9')
  })

  it('reads why a card settled; a card whose watcher is gone has settled too', () => {
    const now = Date.now()
    const dir = dataDir({
      done: watched('connected', { settled_by: 'all_resolved', watching: false }),
      late: watched('not_connected', { settled_by: 'deadline', watching: false }),
      gone: watched('initiated', { pid: 2 ** 22 + 12345 }),
      hung: watched('initiated', { updated_at: (now - STALE_MS - 1000) / 1000 }),
      old: { targets: [{ name: 'gmail', state: 'initiated' }], updated_at: now / 1000, watching: false },
      live: watched('initiated')
    })

    expect(readCard('done', dir)?.settled).toBe('all_resolved')
    expect(readCard('late', dir)?.settled).toBe('deadline')
    expect(readCard('gone', dir)?.settled).toBe('stopped')
    expect(readCard('hung', dir, now)?.settled).toBe('stopped')
    expect(readCard('old', dir)?.settled).toBe('deadline')
    expect(readCard('live', dir)?.settled).toBeUndefined()
  })

  it('a card a newer call replaced draws no card of its own', () => {
    const dir = dataDir({
      'c1.op1': watched('superseded', { settled_by: 'superseded', watching: false })
    })
    const c = stripped()
    c.connect = loadConnect(c, dir)

    expect(c.connect?.settled).toBe('superseded')
    expect(isConnectCall(c)).toBe(false)
    expect(ownsCard(c)).toBe(false)
  })

  it('one pane tells the agent about a card, once', () => {
    const dir = dataDir({ 'c1.op1': watched('connected') })

    expect(claimTold('c1.op1', dir)).toEqual({ kind: 'claimed' })
    expect(claimTold('c1.op1', dir)).toEqual({ kind: 'taken' })
    expect(readCard('c1.op1', dir)?.told).toBe(true)
    expect(loadConnect(stripped(), dir)?.told).toBe(true)
  })

  it('a claim that cannot be written failed: it is not one another pane holds', () => {
    // No connections folder (ENOENT).
    expect(claimTold('c1.op1', mkdtempSync(join(tmpdir(), 'tern-claims-')))).toMatchObject({ error: expect.objectContaining({ code: 'ENOENT' }), kind: 'failed' })

    // A folder this pane may not write (EACCES); root writes anyway.
    const dir = dataDir({ 'c2.op1': watched('connected') })
    chmodSync(join(dir, 'connections'), 0o555)

    try {
      if (process.getuid?.() !== 0) {
        expect(claimTold('c2.op1', dir)).toMatchObject({ error: expect.objectContaining({ code: 'EACCES' }), kind: 'failed' })
      }
    } finally {
      chmodSync(join(dir, 'connections'), 0o755)
    }
  })

  it('marks this pane as the viewer of one session at a time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tern-viewers-'))

    markViewer(storedSessionId('s1'), null, dir, {})
    expect(decodeJson(readFileSync(join(dir, 'viewers', 's1.json'), 'utf8'))).toEqual({ pid: process.pid })
    markViewer(storedSessionId('s2'), storedSessionId('s1'), dir)
    expect(existsSync(join(dir, 'viewers', 's1.json'))).toBe(false)
    expect(existsSync(join(dir, 'viewers', 's2.json'))).toBe(true)
  })

  it("records the pane's Tern variables, for the agent's tools", () => {
    const dir = mkdtempSync(join(tmpdir(), 'tern-viewers-'))

    markViewer(liveSessionId('s1'), null, dir, { HOME: '/h', TERN_PANE: '42', TERN_PANE_SOCKET: '/s/pane', TERN_WINDOW_KEY: '' })
    expect(decodeJson(readFileSync(join(dir, 'viewers', 's1.json'), 'utf8'))).toEqual({
      pid: process.pid,
      tern: { TERN_PANE: '42', TERN_PANE_SOCKET: '/s/pane' }
    })
    expect(ternPane({ TERN_WINDOW_KEY: '3' })).toBeUndefined()
  })

  it('tells the agent which apps the user authorized, or that all are connected', () => {
    expect(continueMessage(connectTargets(call()))).toBe(
      "I've authorized Google Drive, Gmail and Slack. Check with manage_connections status and carry on."
    )
    expect(connectedMessage(connectTargets(call()).map(t => ({ ...t, state: 'connected' })))).toBe(
      'Google Drive, Gmail and Slack are connected now. Carry on.'
    )
  })

  it('counts a card connected when every app it still stands for is', () => {
    const card = (...states: string[]) => ({ opened: [], targets: states.map(state => ({ name: state, state, title: state })), told: false })

    expect(allConnected(card('connected', 'superseded'))).toBe(true)
    expect(allConnected(card('connected', 'initiated'))).toBe(false)
    expect(allConnected(card('superseded'))).toBe(false)
  })

  it('owns a card and stays out of the turn fold', () => {
    const c = call()
    const turn: TurnEntry = {
      blocks: [
        { call: c, id: entryId('b1'), kind: 'tool' },
        { id: entryId('b2'), kind: 'text', text: 'While you authorize those, I will start.' }
      ],
      end: { endedAt: 1000, status: 'done' },
      id: entryId('t'),
      kind: 'turn',
      rev: 0,
      startedAt: 0
    }

    expect(ownsCard(c)).toBe(true)
    expect(foldOf(turn)?.hidden.has('b1') ?? false).toBe(false)
  })
})
