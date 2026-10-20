import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { JSX } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { entryId, toolCallId } from '../core/ids.js'
import { Attachments, type AttachmentsHost, type ClipboardReader, type Image } from '../draft/attachments.js'
import { extractClipboardImage, type Runner, withClipboardImage } from '../hermes/clipboardImage.js'
import { imageSize } from '../hermes/images.js'
import { localSource, Media, shownImage } from '../media.js'
import type { ToolCall, TurnEntry, UserEntry } from '../model.js'
import { promptAttachments, splitPrompt } from '../promptRefs.js'
import { Transcript } from '../transcript.js'
import { imageChip } from '../view/dock.js'
import { toolNode } from '../view/tools/shell.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'
import { foldOf, ownsCard, pieces } from '../workLog.js'

import { FakeGateway } from './fakes.js'

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

const call = (name: string, args: Record<string, unknown>, { id = 'c1', ...more }: Omit<Partial<ToolCall>, 'id'> & { id?: string } = {}): ToolCall => ({
  args,
  argsText: '',
  context: '',
  id: toolCallId(id),
  name,
  startedAt: 0,
  outcome: { duration: 0, kind: 'done' },
  via: { kind: 'direct' },
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
    expect(shownImage(call('image_generate', {}, { result: { error: 'quota', image: null, success: false }, outcome: { duration: 0, kind: 'error' } }))).toBeUndefined()
    expect(shownImage(call('image_generate', { prompt: 'a cat' }, { outcome: { kind: 'running' } }))).toBeUndefined()
  })

  it('vision_analyze shows none (it folds); a browser screenshot: the path in its result', () => {
    expect(shownImage(call('vision_analyze', { image_url: '/h/a.png' }, { outcome: { kind: 'running' } }))).toBeUndefined()
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
    const c = call('browser_vision', {}, { result: { meta: { screenshot_path: '/h/a.png' } } })
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
    const c = call('image_generate', { prompt: 'x' }, { result: { error: 'Content policy', image: null, success: false }, outcome: { duration: 0, kind: 'error' } })
    const n = tree(toolNode(c, 0))
    expect(images(n)).toEqual([])
    expect(n.p?.note).toContain('Content policy')
  })

  it('vision_analyze shows its analysis, not the image it looked at (the user already sees it)', () => {
    const n = tree(toolNode(call('vision_analyze', { image_url: shot, question: 'what?' }, { result: { analysis: 'A chart.', success: true } }), 0))
    expect(images(n)).toEqual([])
    expect(JSON.stringify(n)).toContain('A chart.')
  })

  it('stays out of work groups and folds, so the image is in view', () => {
    const img = call('image_generate', {}, { id: 'g', result: { image: '/h/a.png', success: true } })
    const sh = call('terminal', { command: 'ls' }, { id: 's' })
    const blocks = [
      { call: sh, id: entryId('b1'), kind: 'tool' as const },
      { call: img, id: entryId('b2'), kind: 'tool' as const },
      { id: entryId('b3'), kind: 'text' as const, text: 'Here it is.' }
    ]
    const turn: TurnEntry = { blocks, end: { endedAt: 9, status: 'done' }, id: entryId('t'), kind: 'turn', rev: 0, startedAt: 0 }

    expect(ownsCard(img)).toBe(true)
    expect(pieces(blocks).map(p => p.kind)).toEqual(['work', 'block', 'block'])
    expect([...(foldOf(turn)?.hidden ?? [])]).toEqual(['b1'])

    // A failed one has no image to keep in view.
    const failed: ToolCall = { ...img, outcome: { duration: 0, kind: 'error' } }
    expect(foldOf({ ...turn, blocks: [{ call: failed, id: entryId('b2'), kind: 'tool' }, blocks[2]!] })?.hidden.has('b2')).toBe(true)
  })
})

describe('the composer chip of an attached image', () => {
  it('shows the thumbnail, name and size, and drops the image only from its ✕', () => {
    const onRemove = vi.fn()
    const n = tree(imageChip({ caption: '1280×720 · 12 KB', image: { blob: 'b1' }, label: 'pasted image 1' }, 0, onRemove))

    expect(n).toMatchObject({ k: 'card', p: { head: [{ t: 'pasted image 1' }], role: 'omp.composer.chip' } })
    expect(n.p?.actions).toBeUndefined()
    expect(n.c?.map(c => c.k)).toEqual(['image', 'text', 'icon'])
    // No click of its own on the thumbnail: Tern opens it in its lightbox.
    expect(n.c?.[0]?.p).toMatchObject({ blob: 'b1' })
    expect(n.c?.[0]?.p?.actions).toBeUndefined()
    expect(n.c?.[2]?.p).toMatchObject({ actions: { click: 'click' }, name: 'x', role: 'hermes.composer.remove' })
  })

  it('says it is attaching while the image is read and uploaded, and can be removed meanwhile', () => {
    const onRemove = vi.fn()
    const n = tree(imageChip({ label: 'pasted image 1', pending: true }, 0, onRemove))
    expect(n.c?.[1]?.p?.spans).toEqual([{ fx: 'shimmer', s: 'dim', t: 'Attaching…' }])
    expect(n.c?.[2]?.p).toMatchObject({ actions: { click: 'click' }, role: 'hermes.composer.remove' })
  })

  it('an icon in the thumbnail’s place when there is no image to show', () => {
    expect(tree(imageChip({ label: 'a.png' }, 0, () => undefined)).c?.[0]).toMatchObject({ k: 'icon', p: { name: 'image' } })
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

/** A clipboard read through Hermes' extractor (as off macOS), with `runner` in the extractor's place. */
const clipboardOf = (runner: Runner): ClipboardReader => use =>
  withClipboardImage(use, { HERMES_PYTHON_SRC_ROOT: dir }, (dest, env) => extractClipboardImage(dest, env, 'linux', runner))

/** An extractor that writes the PNG to its destination, as one finding an image does. */
const holding: Runner = async (_file, args) => {
  writeFileSync(args[1] ?? '', PNG)

  return 'true'
}

/** An extractor that finds no image. */
const empty: Runner = async () => 'false'

/** The attachments on a fake host: the uploads go to a fake gateway, notices and renders are counted. */
function attachments({ blob, canonical = true, clipboard = clipboardOf(holding), head, sid = 's1', startup }: { blob?: string; canonical?: boolean; clipboard?: ClipboardReader; head?: Image[]; sid?: string | null; startup?: string } = {}) {
  const gw = new FakeGateway({ canonical })
  let uploads = 0
  gw.handlers.set('image.attach_bytes', () => ({ path: `/uploads/${++uploads}.png` }))
  const notes: { text: string; tone: string | undefined }[] = []
  const changed = vi.fn()

  const host: AttachmentsHost = {
    attachToHead: image => {
      head?.push(image)

      return Boolean(head)
    },
    blob: () => blob,
    changed,
    cwd: () => dir,
    gw: gw.client,
    launchCwd: dir,
    note: (text, tone) => void notes.push({ text, tone }),
    sid: () => sid
  }

  return { a: new Attachments(host, { clipboard, ...(startup ? { startup } : {}) }), changed, gw, notes }
}

describe('Attachments: the draft\'s images', () => {
  it('an empty paste reads the clipboard\'s image and uploads it, with its size and thumbnail', async () => {
    const { a, gw } = attachments({ blob: 'b1' })

    expect(a.paste('')).toBe(true)
    await vi.waitFor(() => expect(a.uploading).toBe(false))

    expect(gw.sent('image.attach_bytes')).toEqual([expect.objectContaining({ filename: 'image.png', session_id: 's1' })])
    expect(a.items).toEqual([{ caption: '1280×720 · 1 KB', mime: 'image/png', name: 'pasted image 1', path: '/uploads/1.png', preview: { blob: 'b1' } }])
  })

  it('a pasted image path attaches that file; text is no image', async () => {
    const { a } = attachments()

    expect(a.paste('hello')).toBe(false)
    expect(a.paste(`'${shot}'`)).toBe(true)
    expect(a.uploading).toBe(true)
    await vi.waitFor(() => expect(a.uploading).toBe(false))

    // No blob and no upload on this machine: no thumbnail.
    expect(a.items).toEqual([{ caption: '1280×720 · 1 KB', mime: 'image/png', name: 'clip_1.png', path: '/uploads/1.png' }])
  })

  it('Ctrl+V says the clipboard holds no image; an empty paste stays quiet', async () => {
    const { a, notes } = attachments({ clipboard: clipboardOf(empty) })

    await a.fromClipboard(true)
    expect(notes).toEqual([])

    await a.fromClipboard(false)
    expect(notes).toEqual([{ text: 'No image on the clipboard.', tone: 'warning' }])
    expect(a.any).toBe(false)
  })

  it('a clipboard that cannot be read says why', async () => {
    const { a, notes } = attachments({ clipboard: clipboardOf(() => Promise.reject(new Error('no display'))) })

    await a.fromClipboard(false)

    expect(notes).toEqual([{ text: 'Could not read the clipboard image: no display', tone: 'error' }])
    expect(a.any).toBe(false)
  })

  it('/image takes an image file, and refuses anything else', async () => {
    const { a, notes } = attachments()

    await a.fromPath('notes.txt')
    expect(notes).toEqual([{ text: 'Not an image file: notes.txt (PNG, JPEG, GIF or WebP)', tone: 'warning' }])

    await a.fromPath(shot)
    expect(a.items.map(i => i.name)).toEqual(['clip_1.png'])
  })

  it('waits for a session before it uploads', async () => {
    const { a, gw, notes } = attachments({ sid: null })

    await a.fromPath(shot)

    expect(gw.sent('image.attach_bytes')).toEqual([])
    expect(notes).toEqual([{ text: 'Wait for the session to start before attaching an image.', tone: 'warning' }])
  })

  it('shows a pending chip while it uploads; Ctrl+C drops it, and the upload lands nowhere', async () => {
    const { a, gw } = attachments()
    let land: (v: unknown) => void = () => undefined
    gw.handlers.set('image.attach_bytes', () => new Promise(resolve => (land = resolve)))

    const attaching = a.fromPath(shot)
    await vi.waitFor(() => expect(gw.sent('image.attach_bytes')).toHaveLength(1))

    expect(a.uploading).toBe(true)
    expect(a.chips()).toEqual([{ label: 'clip_1.png', pending: true }])

    a.clearAll()
    land({ path: '/uploads/late.png' })
    await attaching

    expect(a.any).toBe(false)
  })

  it('Esc Esc clears the landed images, and one still uploading lands after', async () => {
    const { a, gw } = attachments()
    await a.fromPath(shot)
    let land: (v: unknown) => void = () => undefined
    gw.handlers.set('image.attach_bytes', () => new Promise(resolve => (land = resolve)))

    const attaching = a.fromPath(shot)
    await vi.waitFor(() => expect(gw.sent('image.attach_bytes')).toHaveLength(2))
    a.clear()
    expect(a.items).toEqual([])

    land({ path: '/uploads/late.png' })
    await attaching

    expect(a.items.map(i => i.path)).toEqual(['/uploads/late.png'])
  })

  it('take empties the draft; a prompt that did not go puts its images back before the draft\'s', async () => {
    const { a } = attachments()
    await a.fromPath(shot)
    const taken = a.take()

    expect(a.items).toEqual([])
    await a.fromPath(shot)
    a.restore(taken)

    expect(a.items.map(i => i.path)).toEqual(['/uploads/1.png', '/uploads/2.png'])
  })

  it('a chip\'s ✕ drops only its image', async () => {
    const { a, changed } = attachments()
    await a.fromPath(shot)
    await a.fromPath(shot)
    changed.mockClear()

    a.remove(0)

    expect(a.items.map(i => i.path)).toEqual(['/uploads/2.png'])
    expect(changed).toHaveBeenCalledTimes(1)
  })
})

describe('Attachments: the launcher\'s startup image', () => {
  it('goes into the startup query at the queue\'s head, in place', async () => {
    const head: Image[] = []
    const { a } = attachments({ head, startup: shot })
    expect(a.awaitingStartup).toBe(true)

    await a.attachStartup('s1')

    expect(head.map(i => [i.name, i.path])).toEqual([['clip_1.png', '/uploads/1.png']])
    expect(a.items).toEqual([])
    expect(a.awaitingStartup).toBe(false)
  })

  it('goes to the draft when no prompt waits', async () => {
    const { a } = attachments({ startup: shot })

    await a.attachStartup('s1')

    expect(a.items.map(i => i.name)).toEqual(['clip_1.png'])
  })

  it('a private gateway takes it by path', async () => {
    const { a, gw } = attachments({ canonical: false, startup: shot })

    await a.attachStartup('s1')

    expect(gw.sent('image.attach')).toEqual([{ path: shot, session_id: 's1' }])
    expect(gw.sent('image.attach_bytes')).toEqual([])
  })

  it('one that cannot be read is a warning, and the queue goes on', async () => {
    const { a, notes } = attachments({ startup: join(dir, 'gone.png') })

    await a.attachStartup('s1')

    expect(notes).toEqual([{ text: expect.stringMatching(/^Could not attach .*gone\.png: ENOENT/), tone: 'warning' }])
    expect(a.awaitingStartup).toBe(false)
  })
})
