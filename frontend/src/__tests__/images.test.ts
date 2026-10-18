import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { JSX } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { imageSize } from '../hermes/images.js'
import { localSource, Media, shownImage } from '../media.js'
import type { ToolCall, TurnEntry, UserEntry } from '../model.js'
import { promptAttachments, splitPrompt } from '../promptRefs.js'
import { Transcript } from '../transcript.js'
import { imageChip } from '../view/dock.js'
import { toolNode } from '../view/tools.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { foldOf, ownsCard, pieces } from '../workLog.js'

interface Node {
  k: string
  p?: Record<string, unknown>
  c?: Node[]
}

const tree = (n: JSX.Element): Node => JSON.parse(JSON.stringify(n)) as Node
const all = (n: Node): Node[] => [n, ...(n.c ?? []).flatMap(all)]
const images = (n: Node) => all(n).filter(x => x.k === 'image')

const dir = mkdtempSync(join(tmpdir(), 'hermes-tern-images-'))
const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]),
  Buffer.from('IHDR'),
  Buffer.from([0, 0, 5, 0, 0, 0, 2, 208, 8, 6, 0, 0, 0])
])
const shot = join(dir, 'clip_1.png')
writeFileSync(shot, PNG)

const call = (name: string, args: Record<string, unknown>, more: Partial<ToolCall> = {}): ToolCall => ({
  args,
  argsText: '',
  context: '',
  id: 'c1',
  name,
  startedAt: 0,
  status: 'done',
  ...more
})

describe('splitPrompt: what a stored prompt carried', () => {
  it('lifts trailing @image refs and their [screenshot] placeholders out of the words', () => {
    const parts = splitPrompt('look at this\n@image:/h/images/clip_1.png\n@image:`/h/my shot.png`\n[screenshot]\n[screenshot]')
    expect(parts).toEqual({ files: [], images: ['/h/images/clip_1.png', '/h/my shot.png'], text: 'look at this' })
  })

  it('lifts a native-vision suffix of hints and placeholders', () => {
    const parts = splitPrompt('euyhhh it says this\n\n[Image attached at: /h/a.png]\n[Image attached at: /h/b.png]\n[screenshot]\n[screenshot]')
    expect(parts.images).toEqual(['/h/a.png', '/h/b.png'])
    expect(parts.text).toBe('euyhhh it says this')
  })

  it('keeps hints whose placeholders do not add up, and a [screenshot] the user typed', () => {
    const odd = 'x\n\n[Image attached at: /h/a.png]\n[screenshot]\n[screenshot]'
    expect(splitPrompt(odd)).toMatchObject({ images: [], text: odd })
    expect(splitPrompt('what does [screenshot] mean\n[screenshot]').text).toBe('what does [screenshot] mean\n[screenshot]')
  })

  it('cuts the attached context, listing the files the words no longer name', () => {
    const raw = [
      'read the plan and [User attached file: /p/spec.md] then go',
      '',
      '--- Attached Context ---',
      '',
      '📄 @file:PLAN.md (5396 tokens)',
      '```markdown',
      '# Plan',
      '```',
      '📎 @file:desktop/SCR-1.png (image/png, 165.8 KB) — binary file, not inlined as text. It is available on disk at `/h/desktop/SCR-1.png`. Use your tools.',
      '',
      '--- Context Warnings ---',
      'too big'
    ].join('\n')

    expect(splitPrompt(raw)).toEqual({
      files: [{ ref: '@file:PLAN.md' }, { path: '/h/desktop/SCR-1.png', ref: '@file:desktop/SCR-1.png' }],
      images: [],
      text: 'read the plan and [User attached file: /p/spec.md] then go'
    })
  })

  it('does not list a ref the words still hold, and drops trailing context warnings', () => {
    const parts = splitPrompt('see @file:a.ts\n\n--- Attached Context ---\n\n📄 @file:a.ts (10 tokens)\n\n--- Context Warnings ---\nw')
    expect(parts).toEqual({ files: [], images: [], text: 'see @file:a.ts' })
    expect(splitPrompt('hi\n--- Context Warnings ---\nw').text).toBe('hi')
  })

  it('gives each image its file only while it is on disk; a file stays a name', () => {
    const exists = (p: string) => p === '/h/a.png' || p === '/h/d/s.png'
    const list = promptAttachments(
      { files: [{ ref: '@file:notes.md' }, { path: '/h/d/s.png', ref: '@file:d/s.png' }], images: ['/h/a.png', '/h/gone.png'], text: '' },
      exists
    )

    expect(list).toEqual([
      { kind: 'image', name: 'a.png', source: { path: '/h/a.png' } },
      { kind: 'image', name: 'gone.png' },
      { kind: 'file', name: 'notes.md' },
      { kind: 'image', name: 's.png', source: { path: '/h/d/s.png' } }
    ])
  })
})

describe('a resumed prompt with images', () => {
  const cx: TranscriptContext = { copy: () => undefined, now: 0, welcome: { tip: '', version: '' } }

  it('shows its words without the refs, and its images as thumbnails over them', () => {
    const t = new Transcript()
    t.load([{ role: 'user', text: `ion see any new host.\n@image:${shot}\n@image:/nowhere/clip_2.png\n[screenshot]\n[screenshot]` }])
    const user = t.entries.find(e => e.kind === 'user') as UserEntry

    expect(user.text).toBe('ion see any new host.')
    expect(user.attachments).toEqual([
      { kind: 'image', name: 'clip_1.png', source: { path: shot } },
      { kind: 'image', name: 'clip_2.png' }
    ])

    const n = tree(entryNode(user, `main.${user.id}`, cx))
    expect(images(n).map(i => i.p)).toEqual([expect.objectContaining({ path: shot })])
    // The gone image is a chip with its name; no raw ref reaches the bubble.
    expect(all(n).some(x => x.p?.role === 'hermes.user.attachment' && JSON.stringify(x).includes('clip_2.png'))).toBe(true)
    expect(JSON.stringify(n)).not.toMatch(/@image:|\[screenshot\]/)
  })

  it('a resumed in-flight prompt is split the same way', () => {
    const t = new Transcript()
    t.inflight({ user: `hi\n@image:${shot}` } as never)
    expect(t.entries.at(-1)).toMatchObject({ attachments: [{ source: { path: shot } }], kind: 'user', text: 'hi' })
  })
})

describe('shownImage: the image a tool call showed', () => {
  it('image_generate: the host file before the agent-side one, nothing on failure or while it runs', () => {
    expect(shownImage(call('image_generate', {}, { result: { host_image: '/h/i.png', image: '/sandbox/i.png', success: true } }))).toBe('/h/i.png')
    expect(shownImage(call('image_generate', {}, { result: JSON.stringify({ image: 'https://x/i.png', success: true }) }))).toBe('https://x/i.png')
    expect(shownImage(call('image_generate', {}, { result: { error: 'quota', image: null, success: false }, status: 'error' }))).toBeUndefined()
    expect(shownImage(call('image_generate', { prompt: 'a cat' }, { status: 'running' }))).toBeUndefined()
  })

  it('vision_analyze: its image_url; a browser screenshot: the path in its result', () => {
    expect(shownImage(call('vision_analyze', { image_url: '/h/a.png' }, { status: 'running' }))).toBe('/h/a.png')
    expect(shownImage(call('browser_vision', {}, { result: { meta: { screenshot_path: '/h/s.png' } } }))).toBe('/h/s.png')
    expect(shownImage(call('browser_vision', {}, { result: { analysis: 'a page', screenshot_path: '/h/t.png', success: true } }))).toBe('/h/t.png')
    expect(shownImage(call('browser_vision', {}, { resultText: 'Looks fine. Screenshot path: /h/u.png' }))).toBe('/h/u.png')
    expect(shownImage(call('browser_click', {}, { result: { success: true } }))).toBeUndefined()
  })

  it('localSource: paths and file URLs are files; URLs are not', () => {
    expect(localSource('/h/a.png')).toEqual({ path: '/h/a.png' })
    expect(localSource('file:///h/my%20a.png')).toEqual({ path: '/h/my a.png' })
    expect(localSource('https://x/a.png')).toBeUndefined()
    expect(localSource('data:image/png;base64,AAAA')).toBeUndefined()
  })
})

describe('Media: URLs as blobs', () => {
  const ok = (body: Buffer) => Promise.resolve(new Response(body, { status: 200 }))

  it('fetches an http(s) image once and sends its bytes as a blob', async () => {
    const blob = vi.fn(() => 'b1')
    const fetcher = vi.fn(() => ok(PNG))
    const media = new Media({ blob }, fetcher)
    const c = call('image_generate', { prompt: 'cat' }, { result: { image: 'https://x/cat.png', success: true } })
    const done = vi.fn()

    media.show(c, done)
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce())
    expect(c.image).toEqual({ blob: 'b1' })
    expect(blob).toHaveBeenCalledWith(expect.any(Buffer), 'image/png')

    // The same URL on a call rebuilt from history: already there, no second fetch.
    const again = call('image_generate', {}, { result: { image: 'https://x/cat.png', success: true } })
    media.show(again, () => undefined)
    expect(again.image).toEqual({ blob: 'b1' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('decodes a data URL; null for a failed fetch, a page that is no image, or a Tern without blobs', async () => {
    const media = new Media({ blob: () => 'b2' }, () => Promise.reject(new Error('offline')))
    await expect(media.load(`data:image/png;base64,${PNG.toString('base64')}`)).resolves.toEqual({ blob: 'b2' })
    await expect(media.load('https://x/down.png')).resolves.toBeNull()

    const html = new Media({ blob: () => 'b3' }, () => ok(Buffer.from('<html>')))
    await expect(html.load('https://x/page')).resolves.toBeNull()

    const none = new Media({ blob: () => undefined }, () => ok(PNG))
    await expect(none.load('https://x/a.png')).resolves.toBeNull()
  })

  it('leaves a local file to Tern', () => {
    const fetcher = vi.fn(() => ok(PNG))
    const c = call('vision_analyze', { image_url: '/h/a.png' })
    new Media({ blob: () => 'b' }, fetcher).show(c, () => undefined)
    expect(fetcher).not.toHaveBeenCalled()
    expect(c.image).toBeUndefined()
  })
})

describe('image cards', () => {
  it('image_generate shows the picture, open, and not as JSON', () => {
    const n = tree(toolNode(call('image_generate', { prompt: 'a red fox' }, { result: { image: '/h/fox.png', success: true } }), 0))
    expect(images(n).map(i => i.p)).toEqual([expect.objectContaining({ alt: 'a red fox', path: '/h/fox.png' })])
    expect(n.p).toMatchObject({ name: 'image', target: 'a red fox', title: 'Image' })
    expect(n.p?.collapsed).toBe(false)
    expect(all(n).some(x => x.k === 'code')).toBe(false)
  })

  it('a URL shows once its blob came, a link when it could not', () => {
    const url = 'https://fal.media/fox.png'
    const loading = call('image_generate', {}, { result: { image: url, success: true } })
    expect(JSON.stringify(tree(toolNode(loading, 0)))).toContain('Loading the image')

    expect(images(tree(toolNode({ ...loading, image: { blob: 'b9' } }, 0))).map(i => i.p?.blob)).toEqual(['b9'])

    const failed = JSON.stringify(tree(toolNode({ ...loading, image: null }, 0)))
    expect(failed).toContain('Could not load the image')
    expect(failed).toContain(`"href":"${url}"`)
  })

  it('a failed image_generate keeps its error note and shows no image', () => {
    const c = call('image_generate', { prompt: 'x' }, { result: { error: 'Content policy', image: null, success: false }, status: 'error' })
    const n = tree(toolNode(c, 0))
    expect(images(n)).toEqual([])
    expect(n.p?.note).toContain('Content policy')
  })

  it('vision_analyze shows the image it looked at with its analysis', () => {
    const n = tree(toolNode(call('vision_analyze', { image_url: shot, question: 'what?' }, { result: { analysis: 'A chart.', success: true } }), 0))
    expect(images(n).map(i => i.p?.path)).toEqual([shot])
    expect(JSON.stringify(n)).toContain('A chart.')
  })

  it('stays out of work groups and folds, so the image is in view', () => {
    const img = call('image_generate', {}, { id: 'g', result: { image: '/h/a.png', success: true } })
    const sh = call('terminal', { command: 'ls' }, { id: 's' })
    const blocks = [
      { call: sh, id: 'b1', kind: 'tool' as const },
      { call: img, id: 'b2', kind: 'tool' as const },
      { id: 'b3', kind: 'text' as const, text: 'Here it is.' }
    ]
    const turn: TurnEntry = { blocks, endedAt: 9, id: 't', kind: 'turn', rev: 0, startedAt: 0, status: 'done' }

    expect(ownsCard(img)).toBe(true)
    expect(pieces(blocks).map(p => p.kind)).toEqual(['work', 'block', 'block'])
    expect([...(foldOf(turn)?.hidden ?? [])]).toEqual(['b1'])

    // A failed one has no image to keep in view.
    const failed = { ...img, status: 'error' as const }
    expect(foldOf({ ...turn, blocks: [{ call: failed, id: 'b2', kind: 'tool' }, blocks[2]!] })?.hidden.has('b2')).toBe(true)
  })
})

describe('the composer chip of an attached image', () => {
  it('shows the thumbnail, name and size, and drops the image only from its ✕', () => {
    const onRemove = vi.fn()
    const n = tree(imageChip({ caption: '1280×720 · 12 KB', image: { blob: 'b1' }, label: 'pasted image 1', onRemove }, 0))

    expect(n).toMatchObject({ k: 'card', p: { head: [{ t: 'pasted image 1' }], role: 'omp.composer.chip' } })
    expect(n.p?.actions).toBeUndefined()
    expect(n.c?.map(c => c.k)).toEqual(['image', 'text', 'icon'])
    // No click of its own on the thumbnail: Tern opens it in its lightbox.
    expect(n.c?.[0]?.p).toMatchObject({ blob: 'b1' })
    expect(n.c?.[0]?.p?.actions).toBeUndefined()
    expect(n.c?.[2]?.p).toMatchObject({ actions: { click: 'click' }, name: 'x', role: 'hermes.composer.remove' })
  })

  it('an icon in the thumbnail’s place when there is no image to show', () => {
    expect(tree(imageChip({ label: 'a.png', onRemove: () => undefined }, 0)).c?.[0]).toMatchObject({ k: 'icon', p: { name: 'image' } })
  })
})

describe('imageSize', () => {
  it('reads a PNG header, and nothing from bytes that are no image', () => {
    expect(imageSize(PNG)).toEqual({ h: 720, w: 1280 })
    expect(imageSize(Buffer.from('hello world, no image'))).toBeUndefined()
  })

  it('reads GIF, JPEG and WebP headers', () => {
    const gif = Buffer.from([...Buffer.from('GIF89a'), 10, 0, 20, 0])
    expect(imageSize(gif)).toEqual({ h: 20, w: 10 })

    // SOI, an APP0 segment of 4 bytes, then SOF0 with height 300, width 400.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 1, 44, 1, 144, 3])
    expect(imageSize(jpeg)).toEqual({ h: 300, w: 400 })

    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0)
    webp.write('WEBP', 8)
    webp.write('VP8X', 12)
    webp.writeUIntLE(99, 24, 3)
    webp.writeUIntLE(49, 27, 3)
    expect(imageSize(webp)).toEqual({ h: 50, w: 100 })
  })
})
