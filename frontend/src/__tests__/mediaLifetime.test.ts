import { describe, expect, it, vi } from 'vitest'

import { toolCallId } from '../core/ids.js'
import { Media } from '../media.js'
import type { ToolCall } from '../model.js'

const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]),
  Buffer.from('IHDR'),
  Buffer.from([0, 0, 5, 0, 0, 0, 2, 208, 8, 6, 0, 0, 0])
])

const tool = (src: string): ToolCall => ({
  args: {}, argsText: '', context: '', id: toolCallId('image-1'),
  name: 'image_generate', outcome: { kind: 'done', duration: 0 },
  result: { image: src, success: true }, startedAt: 0, via: { kind: 'direct' }
})

describe('Media: session-owned previews', () => {
  it('does not blob/upload or redraw an old image after transcript adoption', async () => {
    let complete!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { complete = resolve })
    const blob = vi.fn(() => 'uploaded')
    const media = new Media({ blob }, () => pending)
    const old = tool('https://x/old.png')
    const notify = vi.fn()

    media.show(old, notify)
    const inFlight = media.load('https://x/old.png')
    media.invalidate() // changed session or rebuilt this session's transcript
    complete(new Response(PNG)) // mocked fetcher ignores cancellation

    await expect(inFlight).resolves.toBeNull()
    await Promise.resolve()
    expect(blob).not.toHaveBeenCalled()
    expect(old.image).toBeUndefined()
    expect(notify).not.toHaveBeenCalled()
  })

  it('can fetch the same image URL again after a session change', async () => {
    const blob = vi.fn(() => 'new-blob')
    const fetcher = vi.fn(async () => new Response(PNG))
    const media = new Media({ blob }, fetcher)

    await expect(media.load('https://x/image.png')).resolves.toEqual({ blob: 'new-blob' })
    media.invalidate()
    await expect(media.load('https://x/image.png')).resolves.toEqual({ blob: 'new-blob' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(blob).toHaveBeenCalledTimes(2)
  })

  it('aborts the composed fetch signal on invalidation', async () => {
    let signal: AbortSignal | undefined
    const media = new Media({ blob: () => 'unused' }, async (_url, init) => {
      signal = init.signal
      return new Response(PNG)
    })

    await media.load('https://x/a.png')
    expect(signal?.aborted).toBe(false)
    media.invalidate()
    expect(signal?.aborted).toBe(true)
  })
})
