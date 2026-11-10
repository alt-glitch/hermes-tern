import type { NodeJson } from '@stencil-hq/tern'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ListedSession } from '../hermes/sessionList.js'
import type { PreviewRow, TranscriptPage, TranscriptReader } from '../hermes/sessionTranscript.js'
import { MORE, sessionDetail } from '../overlays/sessions/detail.js'
import { type Preview, PreviewLoader } from '../overlays/sessions/preview.js'
import { rowDetail, snippet } from '../overlays/sessions/rows.js'

import { must, spanTexts, tree } from './fakes.js'

const user = (text: string, key = text): PreviewRow => ({ key, kind: 'user', steer: false, text })

/** A reader over `pages` (by cursor, `first` for none), counting its reads; `fail` makes the next read throw. */
function fakeReader(pages: Record<string, TranscriptPage> = { first: { next: null, reset: true, rows: [user('hi')] } }) {
  const reads: string[] = []
  const state = { fail: false }
  const reader: TranscriptReader = {
    page: (id, cursor) => {
      const at = cursor ?? 'first'
      reads.push(`page ${id} ${at}`)

      return state.fail ? Promise.reject(new Error('locked')) : Promise.resolve(must(pages[at], `page ${at}`))
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

    expect(reads).toEqual(['page b first'])
    expect(loader.get('b')).toMatchObject({ next: null, status: 'ready' })
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

    expect(reads).toEqual(['page a first', 'page b first'])
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
    expect(reads.filter(r => r === 'page a first')).toHaveLength(2)
  })

  it('reads the next page on request, one at a time, without rows it already holds, and stops at the end', async () => {
    const { reader, reads } = fakeReader({
      first: { next: 'p4', reset: true, rows: [user('one'), user('two')] },
      p4: { next: 'p9', reset: false, rows: [user('two'), user('three')] },
      p9: { next: null, reset: false, rows: [user('four')] }
    })
    const loader = new PreviewLoader(reader, () => {}, { delay: 0, pageSize: 4 })

    loader.select('a')
    await vi.advanceTimersByTimeAsync(0)
    loader.more('a')
    loader.more('a')

    expect(loader.get('a')?.loadingMore).toBe(true)

    await flush()

    expect(loader.get('a')?.rows.map(r => (r.kind === 'user' ? r.text : ''))).toEqual(['one', 'two', 'three'])
    expect(reads.filter(r => r.startsWith('page'))).toEqual(['page a first', 'page a p4'])

    loader.more('a')
    await flush()
    loader.more('a')
    await flush()

    expect(loader.get('a')).toMatchObject({ loadingMore: false, next: null })
    expect(reads.filter(r => r.startsWith('page'))).toEqual(['page a first', 'page a p4', 'page a p9'])
  })

  it('drops what it held when the gateway starts the transcript over', async () => {
    const { reader } = fakeReader({
      first: { next: 'p2', reset: true, rows: [user('new')] },
      p2: { next: 'p3', reset: true, rows: [user('newest'), user('new')] }
    })
    const loader = new PreviewLoader(reader, () => {}, { delay: 0 })

    loader.select('a')
    await vi.advanceTimersByTimeAsync(0)
    loader.more('a')
    await flush()

    expect(loader.get('a')?.rows.map(r => (r.kind === 'user' ? r.text : ''))).toEqual(['newest', 'new'])
    expect(loader.get('a')?.next).toBe('p3')
  })

  it('reads on past a page that adds no line (tool results only)', async () => {
    const { reader, reads } = fakeReader({
      first: { next: 'p3', reset: true, rows: [user('one')] },
      p3: { next: 'p6', reset: false, rows: [] },
      p6: { next: null, reset: false, rows: [user('two')] }
    })
    const loader = new PreviewLoader(reader, () => {}, { delay: 0 })

    loader.select('a')
    await vi.advanceTimersByTimeAsync(0)
    loader.more('a')
    await flush()

    expect(reads.filter(r => r.startsWith('page'))).toEqual(['page a first', 'page a p3', 'page a p6'])
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

const session: ListedSession = {
  branch: 'main', conversation: ID, cwd: '/w/app', id: ID, lastActive: 1_000, lastReply: 'the last reply', messages: 12, model: 'm',
  pinned: false, preview: 'the first prompt', running: false, source: 'tui', startedAt: 500, title: 'Fix CI', workspace: '/w/app'
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
  const d = sessionDetail({ copied: false, focus: () => {}, focused, isCurrent: false, more: () => {}, now: 2_000, preview, session })

  return { blocks: d.blocks, json: d.nodes.map(tree), text: d.nodes.map(tree).flatMap(texts).join('\n') }
}

const ready = (rows: PreviewRow[], next: string | null): Preview => ({
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

  it('shows the listed first prompt and last reply before the conversation loads', () => {
    expect(pane(undefined).text).toContain('the first prompt')
    expect(pane(undefined).text).toContain('the last reply')
    expect(pane(undefined).text).toContain('Loading the conversation…')
    expect(pane(ready([], null)).text).toContain('No messages.')
  })

  it('lists the conversation as blocks, a tool call on one line, and a Load more block while pages remain', () => {
    const rows: PreviewRow[] = [user('hi'), { args: { command: 'bun test' }, key: 't', kind: 'tool', name: 'terminal' }, { key: 'r', kind: 'assistant', text: 'All green.' }]
    const { blocks, text } = pane(ready(rows, 'older'), 'm1')

    expect(blocks).toEqual(['first', 'last', 'm0', 'm1', 'm2', MORE])
    expect(text).toContain('bun test')
    expect(text).toContain('All green.')
    expect(text).toContain('Load older')
    expect(pane(ready(rows, null)).blocks).toEqual(['first', 'last', 'm0', 'm1', 'm2'])
    expect(pane(ready(rows, null)).text).toContain('Start of the conversation.')
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
