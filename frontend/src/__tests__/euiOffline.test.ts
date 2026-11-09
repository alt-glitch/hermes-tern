import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EuiCards, euiDir } from '../eui/cards.js'
import { createSandbox, readOfflineData, type EuiMounted, type EuiNode } from '../eui/sandbox.js'

import { must } from './fakes.js'

function content(node: EuiNode | null): string {
  if (!node || node.t === 'svg') return ''
  return node.t === 'text' ? node.text : node.kids.map(content).join(' ')
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('offline ephemeral-ui rendering', () => {
  it('mounts the pinned catalog without networking and reports unavailable captures honestly', async () => {
    vi.useFakeTimers()
    const network = vi.fn(() => { throw new Error('Rendering must not access the network') })
    vi.stubGlobal('fetch', network)
    const eui = new EuiCards(() => undefined)
    const sb = await createSandbox(euiDir(), 'light')
    const cards = new Map<string, EuiMounted>()
    try {
      for (const kind of eui.kinds) {
        const app = sb.apps().find(a => a.kinds.includes(kind))?.id ?? 'github'
        cards.set(kind, sb.mount(kind, app, () => undefined))
      }
      await vi.advanceTimersByTimeAsync(200)
      expect(cards.size).toBe(50)
      expect(network).not.toHaveBeenCalled()
      expect(content(cards.get('trace')?.snapshot() ?? null)).toContain('Trace data unavailable')
      expect(content(cards.get('intent-contract')?.snapshot() ?? null)).toContain('Source unavailable. No result inferred.')
      // Snapshot-backed ops kinds are not part of card.v0; any registered one follows the same offline facade.
      const ops = must(sb.kinds.find(kind => kind.startsWith('ops-')))
      const app = sb.apps().find(a => a.kinds.includes(ops))?.id ?? 'github'
      const card = sb.mount(ops, app, () => undefined)
      cards.set(ops, card)
      await vi.advanceTimersByTimeAsync(200)
      expect(content(card.snapshot())).toContain('Snapshot unavailable. Nothing is inferred without it.')
      expect(network).not.toHaveBeenCalled()
    } finally {
      for (const card of cards.values()) card.dispose()
      eui.close()
    }
  })

  it('only reads named local assets and rejects URLs, traversal and unknown paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eui-offline-'))
    try {
      mkdirSync(join(dir, 'data'))
      writeFileSync(join(dir, 'data', 'apps.json'), '{"fixture":true}')
      writeFileSync(join(dir, 'secret.json'), '{"private":"synthetic"}')
      writeFileSync(join(dir, 'data', 'unlisted.json'), '{}')
      expect(readOfflineData(dir, 'data/apps.json')).toBe('{"fixture":true}')
      expect(readOfflineData(dir, './data/apps.json')).toBe('{"fixture":true}')
      for (const request of [
        'https://example.invalid/data/apps.json', '//example.invalid/data/apps.json',
        join(dir, 'data', 'apps.json'), 'data/../secret.json', 'data/%2e%2e/secret.json',
        'data/unlisted.json', 'data/apps.json?token=synthetic', 'data/apps.json#fragment',
        'data/trace-fixture.json'
      ]) expect(readOfflineData(dir, request)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
