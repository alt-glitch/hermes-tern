import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { entryId } from '../core/ids.js'
import { EuiCards, euiDir, euiStyles, splitEuiFences, themeSvg } from '../eui/cards.js'
import { createSandbox, type EuiNode } from '../eui/sandbox.js'
import type { TurnEntry } from '../model.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { decodeEuiCard } from '../wire/euiCard.js'

import { tree } from './fakes.js'

const FENCE = String.fromCharCode(96).repeat(3)
const KINDS = new EuiCards(() => undefined).kinds
const settle = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function turn(text: string): TurnEntry {
  return { blocks: [{ id: entryId('block'), kind: 'text', text }], end: { status: 'done' }, id: entryId('turn'), kind: 'turn', rev: 1, startedAt: 0 }
}

function walk(n: EuiNode | null, f: (n: EuiNode) => void) {
  if (!n) {
    return
  }
  f(n)
  if (n.t === 'el') {
    for (const k of n.kids) { walk(k, f) }
  }
}

describe('ephemeral-ui fences', () => {
  it('pins the 50 kinds of card.v0.json at 63e06b29', () => {
    const pin = readFileSync(join(euiDir(), 'PIN.json'), 'utf8')

    expect(pin).toContain('63e06b29ffb0d7c5b9d482abebc0312335897321')
    expect(KINDS).toHaveLength(50)
    expect(KINDS).toContain('merge')
    expect(KINDS).toContain('infra-models')
  })

  it('splits closed fences out of the Markdown around them, in order', () => {
    const text = `Here is the PR:\n\n${FENCE}ephemeral-ui\n{"kind":"merge","app":"github"}\n${FENCE}\n\nand the build:\n${FENCE}ephemeral-ui\n{"kind":"ci","app":"github","title":"CI"}\n${FENCE}\nDone.`
    const parts = splitEuiFences(text, 'b1', KINDS)

    expect(parts.map(p => p.kind)).toEqual(['md', 'card', 'md', 'card', 'md'])
    expect(parts[1]).toEqual({ kind: 'card', key: 'b1:0', spec: { kind: 'merge', app: 'github' } })
    expect(parts[3]).toEqual({ kind: 'card', key: 'b1:1', spec: { kind: 'ci', app: 'github', title: 'CI' } })
  })

  it('leaves an unclosed (still streaming) fence as Markdown', () => {
    expect(splitEuiFences(`x\n${FENCE}ephemeral-ui\n{"kind":"me`, 'b', KINDS)).toEqual([{ kind: 'md', text: `x\n${FENCE}ephemeral-ui\n{"kind":"me` }])
  })

  it('reports a bad card instead of drawing it', () => {
    expect(decodeEuiCard('{"kind":"nope","app":"github"}', KINDS)).toEqual({ error: 'unknown kind nope' })
    expect(decodeEuiCard('not json', KINDS)).toHaveProperty('error')
    expect(decodeEuiCard('{"kind":"merge"}', KINDS)).toHaveProperty('error')
    expect(decodeEuiCard(`{"kind":"merge","app":"github","pad":"${'x'.repeat(17000)}"}`, KINDS)).toHaveProperty('error')
    expect(splitEuiFences(`${FENCE}ephemeral-ui\n{"kind":"nope","app":"x"}\n${FENCE}`, 'b', KINDS)[0]?.kind).toBe('bad')
  })

  it('scopes the kit stylesheet under the card root and binds its host variables to Tern', () => {
    const css = euiStyles()

    expect(css).toContain("[data-eui='card'] .eu-card")
    expect(css).toContain('--h-primary: var(--accent)')
    expect(css).not.toMatch(/(^|\n)body\s*\{/)
    expect(themeSvg('<path stroke="currentColor" fill="var(--h-primary)"/>')).toBe('<path stroke="var(--text)" fill="var(--accent)"/>')
  })
})

describe('ephemeral-ui kit sandbox', () => {
  it('mounts every pinned kind from the repo catalog with content', async () => {
    const sb = await createSandbox(euiDir(), 'light')
    const empty: string[] = []

    for (const kind of KINDS) {
      const app = sb.apps().find(a => a.kinds.includes(kind))?.id ?? 'github'
      const card = sb.mount(kind, app, () => undefined)
      await settle(30)
      let text = 0
      walk(card.snapshot(), n => { if (n.t === 'text') { text += n.text.trim().length } })
      if (text < 20) { empty.push(kind) }
      card.dispose()
    }

    expect(empty).toEqual([])
  }, 60_000)

  it('replays a click into the kit, which redraws the card', async () => {
    const sb = await createSandbox(euiDir(), 'light')
    const changed = vi.fn()
    const card = sb.mount('kanban', 'linear', changed)
    await settle(50)
    const before = JSON.stringify(card.snapshot())
    const ids: number[] = []
    walk(card.snapshot(), n => { if (n.t === 'el' && n.click && n.tag === 'button') { ids.push(n.id) } })

    expect(ids.length).toBeGreaterThan(0)
    let moved = 0

    for (const id of ids) {
      const prior = JSON.stringify(card.snapshot())
      card.click(id)
      await settle(400)
      if (JSON.stringify(card.snapshot()) !== prior) { moved++ }
    }

    expect(moved).toBeGreaterThan(0)
    expect(JSON.stringify(card.snapshot())).not.toBe(before)
    expect(changed).toHaveBeenCalled()
    card.dispose()
  }, 30_000)
})

describe('ephemeral-ui cards in an answer', () => {
  it('draws the card between the Markdown once the kit mounts it', async () => {
    const changed = vi.fn()
    const blobs: string[] = []
    const sheets = new Map<string, string>()
    const eui = new EuiCards(changed, { blob: (_b, mime) => { blobs.push(mime); return `blob${blobs.length}` }, stylesheet: (name, css) => { sheets.set(name, css) } })
    const t = turn(`Merged:\n\n${FENCE}ephemeral-ui\n{"kind":"merge","app":"github"}\n${FENCE}\n\nAll green.`)
    const cx: TranscriptContext = { copy: () => undefined, eui, now: 100, welcome: { tip: '', version: '' } }
    const first = JSON.stringify(tree(entryNode(t, 'main.turn', cx)))

    expect(first).toContain('eui.card.pending')
    await vi.waitFor(() => { expect(changed).toHaveBeenCalled() }, { timeout: 5000 })
    await settle(200)
    const drawn = JSON.stringify(tree(entryNode(t, 'main.turn', cx)))

    expect(drawn).toContain('"role":"eui.card"')
    expect(drawn).toContain('"data-eui-kind":"merge"')
    expect(drawn).toContain('Merged:')
    expect(drawn).toContain('All green.')
    expect(blobs).toContain('image/svg+xml')
    await settle(0)
    expect(sheets.get('ephemeral-ui-inline')).toMatch(/\[data-eui-s='[0-9a-f]{10}'\]/)
    eui.close()
  }, 20_000)
})
