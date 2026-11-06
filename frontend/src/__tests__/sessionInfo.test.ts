import { describe, expect, it, vi } from 'vitest'

import { type CommandHost, localCommand } from '../commands/local.js'
import { liveSessionId } from '../core/ids.js'
import { openSessionInfo, sessionInfoFacts, sessionStatFacts, type SessionInfoHost } from '../overlays/sessionInfo.js'
import { OverlayStack } from '../overlays/overlay.js'
import { SessionState } from '../session/state.js'

import { FakeGateway, key, must, stub, tree } from './fakes.js'

const usageWithoutCacheHit = {
  calls: 3, compressions: 1, context_max: 1000, context_source: 'provider_usage',
  context_used: 250, input: 1200, output: 300, reasoning: 60, total: 1500
}

const info = {
  cwd: '/work/repo',
  model: 'fixture-model',
  profile_name: 'work',
  provider: 'fixture-provider',
  stored_session_id: 'stored-42',
  title: 'Refactor scope',
  tools: { core: ['read', 'terminal'], extension: ['read', 'browser'] },
  usage: { ...usageWithoutCacheHit, cache_hit_pct: 92 }
}

const breakdown = {
  categories: [
    { color: 'accent', id: 'messages', label: 'Conversation', tokens: 200 },
    { color: 'muted', id: 'tools', label: 'Tool definitions', tokens: 75 }
  ],
  context_estimated: true, context_max: 1000, context_percent: 25,
  context_source: 'estimate', context_used: 250, estimated_total: 275, model: 'fixture-model'
}

function setup(active = true) {
  const changed = vi.fn()
  const session = new SessionState(changed)

  if (active) {
    session.ref = { live: liveSessionId('live-1'), stored: null }
    session.info = info
    session.usage = info.usage
  }

  const stack = new OverlayStack({ changed, closed: () => undefined, opened: () => undefined })
  const gw = new FakeGateway({ replies: { 'session.context_breakdown': () => breakdown } })
  const host: SessionInfoHost = { changed, close: o => stack.close(o), gw: gw.client, open: o => stack.open(o), session }

  return { changed, gw, host, session, stack }
}

const flush = () => new Promise(resolve => setImmediate(resolve))
const rendered = (stack: OverlayStack) => {
  const sheet = must(stack.items[0])

  return { sheet, json: tree(sheet.node(stack.rootOf(sheet))) }
}

describe('/info native session sheet', () => {
  it('opens from a session.info fixture, adds the gateway breakdown, and never prompts the model', async () => {
    const { gw, host, stack } = setup()

    await must(localCommand('info')).run(stub<CommandHost>(host), '')
    expect(gw.sent('session.context_breakdown')).toEqual([{ session_id: 'live-1' }])
    await flush()

    const { sheet, json } = rendered(stack)
    const text = JSON.stringify(json)
    expect(json.p).toMatchObject({ head: 'Session info', role: 'omp.overlay.sessionInfo' })
    for (const value of [
      'Refactor scope', 'stored-42', 'live-1', '/work/repo', 'work',
      'fixture-model', 'fixture-provider', '25%', 'Conversation',
      'Tool definitions', '275', '1,200', '1,500'
    ]) {
      expect(text).toContain(value)
    }
    expect(sessionInfoFacts(info, 'live-1')).toContainEqual({ k: 'Live session ID', v: 'live-1' })
    expect(sessionStatFacts(info, info.usage)).toContainEqual({ k: 'Available tools', v: '3' })
    expect(sessionStatFacts(info, info.usage)).toContainEqual({ k: 'Tool groups', v: '2' })
    expect(sessionStatFacts(info, info.usage)).toContainEqual({ k: 'Model API calls', v: '3' })
    expect(text).toContain('"aria":"Close"')
    expect(gw.sent('slash.exec')).toEqual([])
    expect(gw.sent('prompt.submit')).toEqual([])

    expect(sheet.onKey(key('escape'))).toBe(true)
    expect(stack.items).toEqual([])
  })

  it('renders the gateway cache hit percent without phantom cache-token counters', async () => {
    const { host, stack } = setup()

    openSessionInfo(host)
    await flush()
    const text = JSON.stringify(rendered(stack).json)
    expect(sessionStatFacts(info, info.usage)).toContainEqual({ k: 'Cache hit', v: '92%' })
    expect(text).toContain('"k":"Cache hit","v":"92%"')
    expect(text).not.toContain('Cache-read tokens')
    expect(text).not.toContain('Cache-write tokens')
  })

  it('shows Unknown only when the gateway omits cache_hit_pct', () => {
    const { host, session, stack } = setup()
    session.info = { ...info, usage: usageWithoutCacheHit }
    session.usage = usageWithoutCacheHit

    openSessionInfo(host)
    const text = JSON.stringify(rendered(stack).json)
    expect(sessionStatFacts(session.info, session.usage)).toContainEqual({ k: 'Cache hit', v: 'Unknown' })
    expect(sessionStatFacts(info, { ...usageWithoutCacheHit, cache_hit_pct: 0 }))
      .toContainEqual({ k: 'Cache hit', v: '0%' })
    expect(text).toContain('"k":"Cache hit","v":"Unknown"')
    expect(text).toContain('1,200')
  })

  it('shows missing-data state without inventing counts or calling the RPC', () => {
    const { gw, host, stack } = setup(false)

    openSessionInfo(host)
    const { sheet, json } = rendered(stack)
    const text = JSON.stringify(json)
    expect(text).toContain('No active session')
    expect(text).toContain('Unknown')
    expect(text).not.toContain('"v":"0"')
    expect(gw.sent('session.context_breakdown')).toEqual([])
    expect(sheet.onKey(key('escape'))).toBe(true)
    expect(stack.items).toEqual([])
  })

  it('retains event-sourced usage when the gateway cannot supply estimates', async () => {
    const { gw, host, stack } = setup()
    gw.handlers.set('session.context_breakdown', () => { throw new Error('Method not found') })

    openSessionInfo(host)
    await flush()
    const text = JSON.stringify(rendered(stack).json)
    expect(text).toContain('25%')
    expect(text).toContain('1,200')
    expect(text).toContain('Method not found')
  })

  it('does not repaint an old sheet after a session switch', async () => {
    const { changed, gw, host, session } = setup()
    const pending = Promise.withResolvers<typeof breakdown>()
    gw.handlers.set('session.context_breakdown', () => pending.promise)

    openSessionInfo(host)
    session.ref = { live: liveSessionId('live-2'), stored: null }
    changed.mockClear()
    pending.resolve(breakdown)
    await flush()
    expect(changed).not.toHaveBeenCalled()
  })

  it('does not repaint after Escape closes the sheet', async () => {
    const { changed, gw, host, stack } = setup()
    const pending = Promise.withResolvers<typeof breakdown>()
    gw.handlers.set('session.context_breakdown', () => pending.promise)

    openSessionInfo(host)
    must(stack.items[0]).onKey(key('escape'))
    changed.mockClear()
    pending.resolve(breakdown)
    await flush()
    expect(changed).not.toHaveBeenCalled()
  })
})
