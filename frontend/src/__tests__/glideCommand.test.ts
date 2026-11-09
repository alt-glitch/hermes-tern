import { describe, expect, it, vi } from 'vitest'

import { euiHostPort } from '../app/eui-host.js'
import { glideCommand, type GlideDetect, type GlideHost, type GlideMemory } from '../commands/glide.js'
import { localCommand } from '../commands/local.js'
import { liveSessionId } from '../core/ids.js'
import { EuiCards } from '../eui/cards.js'
import { HOST_APPROVE_ID } from '../eui/hostSnapshot.js'
import { SessionState } from '../session/state.js'
import { Transcript } from '../transcript/store.js'

import { must, ofKind, stub } from './fakes.js'

const memory = (m: Partial<GlideMemory> = {}): GlideMemory => ({ sessions: 0, corrections: 0, complete: false, on: false, ...m })
const detected: GlideDetect = {
  os: 'Linux x86_64', cpus: 16, ram_gib: 62.7, gpus: ['RTX 4090 (23 GiB)'], runtimes: ['ollama'],
  z0int: { installed: false, hint: 'pip install z0intelligence' }, memory: memory()
}

function setup(answers: Record<string, unknown> = {}) {
  const session = new SessionState(() => undefined)
  session.ref = { live: liveSessionId('glide-session'), stored: null }
  const transcript = new Transcript()
  const eui = new EuiCards(vi.fn(), undefined, euiHostPort({ session, transcript }, () => true))
  const replies: Record<string, unknown> = {
    'hermes-tern.glide.detect': detected,
    'hermes-tern.glide.sync': memory({ sessions: 42, corrections: 7, complete: true, scanned: 310 }),
    'hermes-tern.glide.enable': memory({ sessions: 42, corrections: 7, complete: true, on: true }),
    ...answers
  }
  const request = vi.fn(async (method: string, _params: Record<string, unknown>) => {
    if (!(method in replies)) throw new Error(`unknown method ${method}`)
    return replies[method]
  })
  const host = { gw: stub<GlideHost['gw']>({ request }), session, transcript, eui }
  const panels = () => transcript.entries.filter(e => e.kind === 'panel').map(e => ofKind(e, 'panel'))
  const view = (index: number) => must(eui.hostView(must(panels()[index])))
  const titles = () => panels().map(p => p.title)
  return { host, request, transcript, eui, panels, view, titles }
}

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

describe('/glide', () => {
  it('is a listed local command', () => {
    expect(localCommand('glide')?.help).toContain('local intelligence')
  })

  it('detects, then builds memory and turns recall on only after two taps', async () => {
    const { host, request, view, titles } = setup()
    await glideCommand(host, '')
    expect(titles()).toEqual(['This machine', 'z0intelligence', 'Build your local memory'])
    expect(request.mock.calls.map(c => c[0])).toEqual(['hermes-tern.glide.detect'])
    expect(request.mock.calls[0]?.[1]).toEqual({ session_id: 'glide-session' })

    must(view(2).activate)(HOST_APPROVE_ID)
    await settle()
    expect(request.mock.calls.at(-1)).toEqual(['hermes-tern.glide.sync', { session_id: 'glide-session', limit: 100 }])
    expect(titles().slice(3)).toEqual(['Local memory built', 'Quote them into matching turns'])
    expect(request.mock.calls.some(c => c[0] === 'hermes-tern.glide.enable')).toBe(false)

    must(view(4).activate)(HOST_APPROVE_ID)
    await settle()
    expect(request.mock.calls.at(-1)).toEqual(['hermes-tern.glide.enable', { session_id: 'glide-session', on: true }])
    expect(titles().at(-1)).toBe('Glide memory is on')
  })

  it('recalls and turns off on request', async () => {
    const { host, request, titles } = setup({
      'hermes-tern.glide.recall': { hits: [{ text: 'never push to main untested', score: 2.1 }] },
      'hermes-tern.glide.enable': memory({ on: false })
    })
    await glideCommand(host, 'recall push main')
    expect(request.mock.calls[0]).toEqual(['hermes-tern.glide.recall', { session_id: 'glide-session', query: 'push main' }])
    await glideCommand(host, 'off')
    expect(titles()).toEqual(['Your corrections about “push main”', 'Glide memory is off'])
  })

  it('says so when the backend is missing instead of drawing cards', async () => {
    const { host, transcript, titles } = setup({})
    host.gw = stub<GlideHost['gw']>({ request: vi.fn(async () => { throw new Error('method not found') }) })
    await glideCommand(host, '')
    expect(titles()).toEqual([])
    expect(JSON.stringify(transcript.entries.at(-1))).toContain('method not found')
  })
})
