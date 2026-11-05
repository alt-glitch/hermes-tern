import { Node, node, type JSX } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import type { SessionHost } from '../commands/session.js'
import { reviewHunks, reviewSide, reviewTargets } from '../code/review.js'
import { Composer } from '../draft/composer.js'
import type { ChangedFile } from '../git/status.js'
import { openCodeReview, type CodeReviewHost, type CodeReviewSource } from '../overlays/codeReview.js'
import type { Overlay } from '../overlays/overlay.js'

import { key, must, stub } from './fakes.js'

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,4 @@',
  ' stay',
  '-old',
  '+new',
  '+extra',
  ' tail',
  '@@ -25,2 +26,1 @@',
  '-gone',
  ' keep',
  ''
].join('\n')

const SECOND = [
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1 +1 @@',
  '-before',
  '+after',
  ''
].join('\n')

const files: ChangedFile[] = [
  { additions: 2, deletions: 2, path: 'src/a.ts', staged: false, status: 'modified' },
  { additions: 1, deletions: 1, path: 'src/b.ts', staged: false, status: 'modified' }
]

function fixture() {
  const parent: Overlay = {
    key: 'changes',
    modal: true,
    node: id => node('col', { key: id }),
    onKey: () => true
  }
  const overlays: Overlay[] = [parent]
  const changed = vi.fn()
  const send = vi.fn()
  const composer = new Composer()
  composer.set('existing draft', { cursor: 4, pasted: ['!literal'] })
  const draft = vi.fn((text: string) => {
    composer.set(composer.text ? text + '\n' + composer.text : text, { pasted: composer.pasted })
  })
  const session = stub<SessionHost>({ draft, send, stale: () => false })
  const host: CodeReviewHost = {
    changed,
    close: overlay => {
      const index = overlays.indexOf(overlay)
      if (index !== -1) {
        overlays.splice(index, 1)
        overlay.onClose?.()
        changed()
      }
    },
    control: () => session,
    open: overlay => {
      overlays.push(overlay)
      changed()
    },
    overlays
  }
  const diffs = new Map<string, string | null>([['src/a.ts', DIFF], ['src/b.ts', SECOND]])
  const load = vi.fn()
  const source: CodeReviewSource = { diffs, files, load, parent }
  openCodeReview(host, source, 'src/a.ts')

  const review = must(overlays.at(-1))
  const walk = (elements: readonly JSX.Element[]): Node[] =>
    elements.flatMap(element => element instanceof Node ? [element, ...walk(element.children)] : [])
  const nodes = () => walk([review.node('layer.overlay-2')])
  const element = (name: string) => nodes().find(item => item.props['key'] === name)
  const click = (name: string) => {
    const action = element(name)?.handlers?.onClick
    if (!action) throw new Error('Missing native action: ' + name)
    return action({ act: 'click', ev: 'action', id: 'fixture', raw: {}, sf: 'hermes' })
  }
  const typeNote = (text: string) => {
    const action = element('note-input')?.handlers?.onEdit
    if (!action) throw new Error('Missing native note input')
    action(stub<Parameters<typeof action>[0]>({ cursor: text.length, from: 0, len: 0, raw: {}, text, to: 0 }))
  }

  return { changed, click, composer, draft, element, load, nodes, overlays, review, send, typeNote }
}

describe('split code review model', () => {
  it('aligns additions, deletions and context across hunk offsets without inventing lines', () => {
    const hunks = reviewHunks(DIFF)
    expect(hunks).toHaveLength(2)
    expect(hunks[0]?.pairs.map(pair => [pair.old?.line, pair.next?.line])).toEqual([
      [10, 10],
      [11, 11],
      [undefined, 12],
      [12, 13]
    ])
    expect(hunks[1]?.pairs.map(pair => [pair.old?.line, pair.next?.line])).toEqual([
      [25, undefined],
      [26, 26]
    ])
    expect(reviewSide(must(hunks[0]), 'old')).toContain('  11 - old')
    expect(reviewSide(must(hunks[0]), 'new')).toContain('  11 + new')
    expect(reviewSide(must(hunks[0]), 'new')).toContain('  12 + extra')
    expect(reviewTargets(hunks)).toEqual([
      { line: 11, side: 'new' },
      { line: 11, side: 'old' },
      { line: 12, side: 'new' },
      { line: 25, side: 'old' }
    ])
    expect(reviewHunks('Binary files differ')).toEqual([])
  })

  it('renders both old and new code columns for the selected file', () => {
    const f = fixture()
    expect(f.element('old-code-0')?.props['text']).toContain('  11 - old')
    expect(f.element('new-code-0')?.props['text']).toContain('  12 + extra')
    expect(f.element('old-code-1')?.props['text']).toContain('  25 - gone')
    expect(f.element('new-code-0')?.props['lang']).toBe('typescript')
    expect(f.load).toHaveBeenCalledWith(files[0])
  })
})

describe('code-review pane from Changes', () => {
  it('selects files by the rail and j/k, then Escape returns to Changes', () => {
    const f = fixture()
    expect(f.element('selected-path')?.props['spans']).toEqual([{ s: 'strong path', t: 'src/a.ts' }])
    f.click('file-1')
    expect(f.element('selected-path')?.props['spans']).toEqual([{ s: 'strong path', t: 'src/b.ts' }])
    expect(f.element('new-code-0')?.props['text']).toContain('   1 + after')
    f.review.onKey(key('k'))
    expect(f.element('selected-path')?.props['spans']).toEqual([{ s: 'strong path', t: 'src/a.ts' }])
    f.review.onKey(key('j'))
    expect(f.element('selected-path')?.props['spans']).toEqual([{ s: 'strong path', t: 'src/b.ts' }])
    f.review.onKey(key('escape'))
    expect(f.overlays.map(item => item.key)).toEqual(['changes'])
  })

  it('inserts path:line and note before an existing composer draft without sending', () => {
    const f = fixture()
    f.review.onKey(key('down'))
    f.review.onKey(key('down'))
    expect(f.element('target')?.props['text']).toContain('src/a.ts:12 (new, 3/4)')
    f.click('note-start')
    f.typeNote('Check boundary handling')
    expect(f.draft).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
    f.click('note-insert')
    expect(f.composer.text).toBe('src/a.ts:12: Check boundary handling\nexisting draft')
    expect(f.composer.pasted).toEqual(['!literal'])
    expect(f.send).not.toHaveBeenCalled()
    expect(f.overlays).toHaveLength(0)
  })

  it('Escape cancels note entry first and retains the draft until explicitly inserted', () => {
    const f = fixture()
    f.review.onKey(key('n'))
    f.typeNote('Do not insert')
    f.review.onKey(key('escape'))
    expect(f.element('note-input')).toBeUndefined()
    expect(f.composer.text).toBe('existing draft')
    f.review.onKey(key('escape'))
    expect(f.overlays.map(item => item.key)).toEqual(['changes'])
    expect(f.draft).not.toHaveBeenCalled()
  })
})
