import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

import type { Overlay, OverlayHost } from '../overlays/overlay.js'
import { promptOverlay } from '../overlays/prompts.js'
import { parsePrompt } from '../prompts/parse.js'

import { key, must, spanTexts, tree } from './fakes.js'
import { assignedRoot } from './overlayRoots.js'

type Choice = string | { id: string; label: string; detail?: string }

/** A real clarify sheet over a host-owned request, with its actual response captured. */
function ask(choices: Choice[], multi = false) {
  const answers: Record<string, unknown>[] = []
  const host: OverlayHost = { changed: () => undefined, close: () => undefined, open: () => undefined }
  const req: ServerRequest = {
    fail: () => undefined,
    id: 'preview',
    method: 'clarify',
    params: { questions: [{ choices, multi_select: multi, qid: 'db', question: 'Which database?' }] },
    respond: result => answers.push(result)
  }

  const overlay = must(promptOverlay(host, must(parsePrompt(req))))

  return { answers, overlay }
}

function node(overlay: Overlay): NodeJson {
  return tree(overlay.node(assignedRoot(overlay)))
}

function roleNode(root: NodeJson, role: string): NodeJson | undefined {
  if (root.p?.['role'] === role) {
    return root
  }

  for (const child of root.c ?? []) {
    const found = roleNode(child, role)

    if (found) {
      return found
    }
  }

  return undefined
}

function preview(overlay: Overlay): string | undefined {
  const root = roleNode(node(overlay), 'omp.ask.preview')

  if (!root) {
    return undefined
  }

  const spans = (n: NodeJson): string[] => [...spanTexts(n.p?.['spans']), ...(n.c ?? []).flatMap(spans)]

  return spans(root).join(' ')
}

describe('clarify option previews and Other check', () => {
  it('does not draw previews or change the Other row for legacy string choices', () => {
    const { overlay } = ask(['main', 'dev'])

    expect(preview(overlay)).toBeUndefined()
    expect(roleNode(node(overlay), 'omp.ask.other')).toBeDefined()
    expect(roleNode(node(overlay), 'omp.ask.other.check')).toBeUndefined()
    overlay.onKey(key('down'))
    expect(preview(overlay)).toBeUndefined()
  })

  it('previews the highlighted host option and requires Enter after selection', () => {
    const { answers, overlay } = ask([
      { detail: 'Local single-file storage', id: 'sqlite', label: 'SQLite' },
      { detail: 'Shared network database', id: 'postgres', label: 'Postgres' }
    ])

    expect(preview(overlay)).toContain('SQLite Local single-file storage')
    overlay.onKey(key('down'))
    expect(preview(overlay)).toContain('Postgres Shared network database')
    expect(preview(overlay)).not.toContain('Local single-file storage')
    expect(answers).toEqual([])

    overlay.onKey(key('2'))
    expect(answers).toEqual([])
    overlay.onKey(key('enter'))
    expect(answers).toEqual([{ answers: { db: 'Postgres' } }])
  })

  it('checks Other only for entered text, preserving checked choices until explicit submission', () => {
    const { answers, overlay } = ask(['SQLite', 'Postgres'], true)
    const other = () => roleNode(node(overlay), 'omp.ask.other.check')

    expect(roleNode(node(overlay), 'omp.ask.other')).toBeDefined()
    expect(other()).toBeUndefined()
    overlay.onKey(key('space'))
    overlay.onKey(key('down'))
    overlay.onKey(key('down'))
    for (const ch of 'custom') {
      overlay.onKey(key(ch, { text: ch }))
    }

    expect(other()?.p?.['icon']).toBe('check')
    expect(answers).toEqual([])
    overlay.onKey(key('escape'))
    expect(other()?.p?.['icon']).toBe('check')
    overlay.onKey(key('up'))
    expect(answers).toEqual([])
    overlay.onKey(key('enter'))
    expect(answers).toEqual([{ answers: { db: JSON.stringify(['SQLite', 'custom']) } }])
  })

  it('keeps a single-choice Other as free text without an implicit answer', () => {
    const { answers, overlay } = ask(['SQLite', 'Postgres'])

    overlay.onKey(key('down'))
    overlay.onKey(key('down'))
    expect(roleNode(node(overlay), 'omp.ask.other')).toBeDefined()
    overlay.onKey(key('c', { text: 'c' }))
    overlay.onKey(key('u', { text: 'u' }))
    expect(answers).toEqual([])
    overlay.onKey(key('enter'))
    expect(answers).toEqual([{ answers: { db: 'cu' } }])
  })
})
