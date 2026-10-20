import type { CompletionItem } from '@hermes/shared/gateway-events'
import { describe, expect, it, vi } from 'vitest'

import { CommandCatalog, resolveSlashName } from '../commands/resolve.js'
import { slashItems } from '../overlays/completion.js'
import { openHelp } from '../overlays/help.js'
import type { Overlay } from '../overlays/overlay.js'

import { must, stub } from './fakes.js'

const catalog = {
  canon: {
    '/bundles': '/bundles',
    '/busy': '/busy',
    '/heartbeat': '/heartbeat',
    '/hb': '/heartbeat',
    '/mouse': '/mouse',
    '/plan': '/plan',
    '/planner': '/planner',
    '/status': '/status',
    '/statusbar': '/statusbar'
  },
  skills: { '/arx': {} }
}

describe('resolveSlashName', () => {
  it('expands an alias and a unique prefix to the canonical name', () => {
    expect(resolveSlashName('hb', catalog)).toEqual({ name: 'heartbeat' })
    expect(resolveSlashName('hea', catalog)).toEqual({ name: 'heartbeat' })
    expect(resolveSlashName('HEA', catalog)).toEqual({ name: 'heartbeat' })
  })

  it('leaves a canonical name, a skill and an unknown name as typed', () => {
    expect(resolveSlashName('heartbeat', catalog)).toBeNull()
    expect(resolveSlashName('plan', catalog)).toBeNull()
    expect(resolveSlashName('nothing-like-it', catalog)).toBeNull()
    // `/arx` is a skill's whole name; it never widens into a command it prefixes.
    expect(resolveSlashName('arx', { ...catalog, canon: { ...catalog.canon, '/arxiv-tools': '/arxiv-tools' } })).toBeNull()
  })

  it('names every command a prefix ties, and lets a prefix beat a substring', () => {
    expect(resolveSlashName('bu', catalog)).toEqual({ ambiguous: ['/bundles', '/busy'] })
    // /statusbar is hidden (Ink-only): `stat` means /status alone.
    expect(resolveSlashName('stat', catalog)).toEqual({ name: 'status' })
    // `beat` is only a substring of /heartbeat: the lone match runs.
    expect(resolveSlashName('beat', catalog)).toEqual({ name: 'heartbeat' })
  })

  it("resolves this frontend's own commands, and never to an Ink-only one", () => {
    expect(resolveSlashName('sideb', catalog)).toEqual({ name: 'sidebar' })
    expect(resolveSlashName('mou', catalog)).toBeNull()
    // Without a catalog (it failed to load), the frontend's own commands still resolve.
    expect(resolveSlashName('pul', undefined)).toEqual({ name: 'prs' })
  })
})

describe('CommandCatalog', () => {
  it('loads once per session, again after reset, and retries a failed load', async () => {
    let fail = true
    const request = vi.fn(async () => {
      if (fail) {
        throw new Error('down')
      }

      return catalog
    })
    const cache = new CommandCatalog(stub({ request }))

    expect(await cache.get('s1')).toBeUndefined()
    fail = false
    expect(await cache.get('s1')).toBe(catalog)
    await cache.get('s1')
    expect(request).toHaveBeenCalledTimes(2)

    await cache.get('s2')
    expect(request).toHaveBeenLastCalledWith('commands.catalog', { session_id: 's2' })
    cache.reset()
    await cache.get('s2')
    expect(request).toHaveBeenCalledTimes(4)
  })
})

const row = (text: string, kind = 'command', meta = ''): CompletionItem => ({ display: text, kind, meta, text })

describe('slashItems', () => {
  it("drops the hidden commands and adds this frontend's own by name", () => {
    const items = slashItems([row('/plan'), row('/mouse'), row('/pet'), row('/pdf', 'skill')], '/p')

    expect(items.map(i => i.text)).toEqual(['/plan', '/ps', '/prs', '/pdf'])
    expect(items.find(i => i.text === '/ps')).toMatchObject({ kind: 'command', meta: 'Background processes and cron jobs' })
  })

  it('ranks a name prefix above a description match, the gateway order kept within a tier', () => {
    const items = slashItems([row('/branch', 'command', 'fork the changes'), row('/rollback', 'command', 'undo changes')], '/chan')

    expect(items.map(i => i.text)).toEqual(['/changes', '/branch', '/rollback'])
  })

  it('matches an alias, and lists no row twice', () => {
    expect(slashItems([], '/pulls').map(i => i.text)).toEqual(['/prs'])
    expect(slashItems([row('/theme')], '/them').map(i => i.text)).toEqual(['/theme'])
  })

  it("offers nothing for an Ink-only command's arguments, and keeps another command's", () => {
    expect(slashItems([row('hidden'), row('expanded')], '/details ')).toEqual([])
    expect(slashItems([row('tern'), row('nous')], '/theme ').map(i => i.text)).toEqual(['tern', 'nous'])
  })
})

describe('/help', () => {
  it("lists this frontend's own commands with their help, and none of the Ink-only ones", async () => {
    let sheet: Overlay | undefined
    const categories = [
      { name: 'Session', pairs: [['/new', 'Start a new session']] },
      { name: 'TUI', pairs: [['/mouse', 'Set mouse tracking'], ['/logs', 'Show logs']] }
    ]
    const app = {
      gw: { request: async () => ({ categories }) },
      open: (o: Overlay) => (sheet = o),
      session: { info: null, ref: { live: 's1', stored: null } },
      transcript: { notice: vi.fn() }
    }

    await openHelp(stub(app))
    const text = JSON.stringify(must(sheet).node('layer.help'))

    expect(text).toContain('"head":"Tern"')
    expect(text).toContain('/ps · /bashes · /shells · /processes')
    expect(text).toContain('Background processes and cron jobs')
    expect(text).toContain('/new')
    expect(text).not.toContain('/mouse')
    expect(text).not.toContain('"head":"TUI"')
  })
})
