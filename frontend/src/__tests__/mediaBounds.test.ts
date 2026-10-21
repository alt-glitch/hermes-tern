import { describe, expect, it, vi } from 'vitest'

import { Media } from '../media.js'

const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]),
  Buffer.from('IHDR'),
  Buffer.from([0, 0, 5, 0, 0, 0, 2, 208, 8, 6, 0, 0, 0])
])
const MAX = 16 * 1024 * 1024

describe('Media: bounded remote image reads', () => {
  it('accepts a small image when Content-Length is absent', async () => {
    const blob = vi.fn(() => 'good')
    const fetcher = vi.fn(async () => new Response(PNG, { status: 200 }))
    const media = new Media({ blob }, fetcher)

    await expect(media.load('https://example.com/small.png')).resolves.toEqual({ blob: 'good' })
    expect(blob).toHaveBeenCalledWith(expect.any(Buffer), 'image/png')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('rejects declared oversize before consuming the response body', async () => {
    const blob = vi.fn(() => 'should-not-load')
    const media = new Media({ blob }, async () => new Response(PNG, {
      headers: { 'content-length': String(MAX + 1) },
      status: 200
    }))

    await expect(media.load('https://example.com/too-large.png')).resolves.toBeNull()
    expect(blob).not.toHaveBeenCalled()
  })

  it('stops reading an unbounded chunked image without a size header', async () => {
    const blob = vi.fn(() => 'should-not-load')
    const cancelled = vi.fn()
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        controller.enqueue(new Uint8Array(2 * 1024 * 1024))
      },
      cancel: cancelled
    })
    const media = new Media({ blob }, async () => new Response(stream, { status: 200 }))

    await expect(media.load('https://example.com/chunked.png')).resolves.toBeNull()
    expect(blob).not.toHaveBeenCalled()
    expect(cancelled).toHaveBeenCalledOnce()
    expect(pulls).toBeLessThan(14)
  })

  it('does not decode an oversized base64 data URL', async () => {
    const blob = vi.fn(() => 'should-not-load')
    const media = new Media({ blob })
    const enormous = Buffer.alloc(MAX + 1).toString('base64')

    await expect(media.load(`data:image/png;base64,${enormous}`)).resolves.toBeNull()
    expect(blob).not.toHaveBeenCalled()
  })
})
