import type { NodeJson } from '@stencil-hq/tern'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StoredSession } from '../hermes/sessionIndex.js'
import type { PreviewRow, TranscriptPage, TranscriptReader } from '../hermes/sessionTranscript.js'
import { MORE, sessionDetail } from '../overlays/sessions/detail.js'
import { type Preview, PreviewLoader } from '../overlays/sessions/preview.js'
import { rowDetail, snippet } from '../overlays/sessions/rows.js'

import { must, spanTexts, tree } from './fakes.js'

const user = (text: string, key = text): PreviewRow => ({ key, kind: 'user', steer: false, text })

/** A reader over `pages` (by cursor), counting its reads; `fail` makes the next read throw. */
function fakeReader(pages: Record<number, TranscriptPage> = { 0: { next: null, rows: [user('hi')] } }) {
  const reads: string[] = []
  const state = { fail: false }
  const reader: TranscriptReader = {
    ends: id => {
      reads.push(`ends ${id}`)

      return state.fail ? Promise.reject(new Error('locked')) : Promise.resolve({ firstPrompt: `first of ${id}`, lastReply: `last of ${id}` })
    },
    page: (id, after) => {
      reads.push(`page ${id} ${after}`)

      return Promise.resolve(must(pages[after], `page ${after}`))
    }
  }

  return { reader, reads, state }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

describe('PreviewLoader', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads only once the selection rests, and only the session it rests on', async () => {
    const { reader, reads } = fakeReader()
    const loader = new PreviewLoader(reader, () => {}, { delay: 200 })

    loader.select('a')
    await vi.advanceTimersByTimeAsync(100)
    loader.select('b')
    await vi.advanceTimersByTimeAsync(199)

    expect(reads).toEqual([])
    expect(loader.get('b')).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1)
    await flush()

    expect(reads).toEqual(['ends b', 'page b 0'])
    expect(loader.get('b')).toMatchObject({ ends: { lastReply: 'last of b' }, next: null, status: 'ready' })
    expect(loader.get('a')).toBeUndefined()
  })

  it('keeps a loaded session: selecting it again reads nothing', async () => {
    const { reader, reads } = fakeReader()
    const loader = new PreviewLoader(reader, () => {}, { delay: 10 })

    loader.select('a')
    await vi.advanceTimersByTimeAsync(10)
    loader.select('b')
    await vi.advanceTimersByTimeAsync(10)
    loader.select('a')
    await vi.advanceTimersByTimeAsync(50)

    expect(reads).toEqual(['ends a', 'page a 0', 'ends b', 'page b 0'])
  })

  it('shows loading, then the error; selecting the session again retries', async () => {
    const { reader, reads, state } = fakeReader()
    const changed = vi.fn()
    const loader = new PreviewLoader(reader, changed, { delay: 10 })
    state.fail = true

    loader.select('a')
    await vi.advanceTimersByTimeAsync(10)

    expect(changed).toHaveBeenCalled()
    expect(loader.get('a')).toMatchObject({ error: 'locked', status: 'error' })

    state.fail = false
    loader.select('a')
    await vi.advanceTimersByTimeAsync(10)

    expect(loader.get('a')?.status).toBe('ready')
    expect(reads.filter(r => r === 'ends a')).toHaveLength(2)
  })

  it('reads the next page on request, one at a time, without rows it already holds, and stops at the end', async () => {
    const { reader, reads } = fakeReader({
      0: { next: 4, rows: [user('one'), user('two')] },
      4: { next: 9, rows: [user('two'), user('three')] },
      9: { next: null, rows: [user('four')] }
    })
    const loader = new PreviewLoader(reader, () => {}, { delay: 0, pageSize: 4 })

    loader.select('a')
    await vi.advanceTimersByTimeAsync(0)
    loader.more('a')
    loader.more('a')

    expect(loader.get('a')?.loadingMore).toBe(true)

    await flush()

    expect(loader.get('a')?.rows.map(r => (r.kind === 'user' ? r.text : ''))).toEqual(['one', 'two', 'three'])
    expect(reads.filter(r => r.startsWith('page'))).toEqual(['page a 0', 'page a 4'])

    loader.more('a')
    await flush()
    loader.more('a')
    await flush()

    expect(loader.get('a')).toMatchObject({ loadingMore: false, next: null })
    expect(reads.filter(r => r.startsWith('page'))).toEqual(['page a 0', 'page a 4', 'page a 9'])
  })

  it('reads on past a page that adds no line (tool results only)', async () => {
    const { reader, reads } = fakeReader({
      0: { next: 3, rows: [user('one')] },
      3: { next: 6, rows: [] },
      6: { next: null, rows: [user('two')] }
    })
    const loader = new PreviewLoader(reader, () => {}, { delay: 0 })

    loader.select('a')
    await vi.advanceTimersByTimeAsync(0)
    loader.more('a')
    await flush()

    expect(reads.filter(r => r.startsWith('page'))).toEqual(['page a 0', 'page a 3', 'page a 6'])
    expect(loader.get('a')?.rows).toHaveLength(2)
  })

  it('draws nothing for a read that outlives the picker', async () => {
    const { reader } = fakeReader()
    const changed = vi.fn()
    const loader = new PreviewLoader(reader, changed, { delay: 10 })

    loader.select('a')
    await vi.advanceTimersByTimeAsync(10)
    changed.mockClear()
    loader.select('b')
    loader.dispose()
    await vi.advanceTimersByTimeAsync(50)

    expect(changed).not.toHaveBeenCalled()
  })
})

describe('list rows', () => {
  it('reads as one clean line', () => {
    expect(snippet('# Fix it\n\n- see [the docs](https://x.y)\n```ts\nconst a = 1\n```\n@image:/tmp/a.png\nuse `bun` **now**')).toBe(
      'Fix it see the docs [code] use bun now'
    )
    expect(snippet('x'.repeat(200), 20)).toHaveLength(20)
  })

  it('goes on from the label when the session has no title', () => {
    expect(rowDetail({ preview: 'Why is CI red? Look at the logs.', title: '' })).toBe('Look at the logs.')
    expect(rowDetail({ preview: 'Why is CI red?', title: '' })).toBe('')
    expect(rowDetail({ preview: 'Look at the logs.', title: 'CI' })).toBe('Look at the logs.')
  })
})

const ID = 'local-c17b6fd5a5334f0e9d1c2b3a4f5e6d7c8b9a0f1e'

const session: StoredSession = {
  branch: 'main', cwd: '/w/app', id: ID, lastActive: 1_000, messages: 12, model: 'm', pinned: false,
  preview: 'the first prompt, cut at 400', repoRoot: '/w/app', source: 'tui', startedAt: 500, title: 'Fix CI'
}

/** Every text a node tree shows: `text` props and span texts. */
function texts(n: NodeJson): string[] {
  const own: string[] = []
  const p = n.p ?? {}

  if (typeof p['text'] === 'string') {
    own.push(p['text'])
  }

  return [...own, ...spanTexts(p['spans']), ...(n.c ?? []).flatMap(texts)]
}

function pane(preview: Preview | undefined, focused?: string) {
  const d = sessionDetail({ copied: false, focus: () => {}, focused, isCurrent: false, more: () => {}, now: 2_000, preview, running: false, session })

  return { blocks: d.blocks, json: d.nodes.map(tree), text: d.nodes.map(tree).flatMap(texts).join('\n') }
}

const ready = (rows: PreviewRow[], next: number | null): Preview => ({
  ends: { firstPrompt: 'the whole first prompt', lastReply: 'the whole last reply' },
  loadingMore: false,
  next,
  rows,
  status: 'ready'
})

describe('the preview pane', () => {
  it('shows the session id whole, never cut', () => {
    const { json, text } = pane(undefined)
    const id = must(json.find(n => n.p?.['role'] === 'hermes.sessions.id'))

    expect(texts(id)).toContain(ID)
    expect(text).not.toMatch(/local-c17b6fd5a533[^\n]*…/)
  })

  it('shows the first prompt and last reply whole once loaded, the listed prompt before', () => {
    expect(pane(undefined).text).toContain('the first prompt, cut at 400')
    expect(pane(undefined).text).toContain('Loading the conversation…')

    const loaded = pane(ready([], null)).text

    expect(loaded).toContain('the whole first prompt')
    expect(loaded).toContain('the whole last reply')
    expect(loaded).toContain('No messages.')
  })

  it('lists the conversation as blocks, a tool call on one line, and a Load more block while pages remain', () => {
    const rows: PreviewRow[] = [user('hi'), { args: { command: 'bun test' }, key: 't', kind: 'tool', name: 'terminal' }, { key: 'r', kind: 'assistant', text: 'All green.' }]
    const { blocks, text } = pane(ready(rows, 7), 'm1')

    expect(blocks).toEqual(['first', 'last', 'm0', 'm1', 'm2', MORE])
    expect(text).toContain('bun test')
    expect(text).toContain('All green.')
    expect(text).toContain('Load more')
    expect(pane(ready(rows, null)).blocks).toEqual(['first', 'last', 'm0', 'm1', 'm2'])
    expect(pane(ready(rows, null)).text).toContain('End of the conversation.')
  })

  it('marks the focused block for Tern', () => {
    const { json } = pane(ready([user('hi')], null), 'm0')

    expect(json.filter(n => n.p?.['role'] === 'omp.picker.block.focused').map(n => n.p?.['key'])).toEqual(['m0'])
  })

  it('says why a session could not be read', () => {
    expect(pane({ error: 'database is locked', loadingMore: false, next: null, rows: [], status: 'error' }).text).toContain(
      'Could not read this session: database is locked'
    )
  })
})
