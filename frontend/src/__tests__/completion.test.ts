import type { CompletionItem } from '@hermes/shared/gateway-events'
import type { Key } from '@stencil-hq/tern'
import type { GatewayClient } from '@tui/gatewayClient.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Composer } from '../composer.js'
import { Completion } from '../overlays/completion.js'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))

interface Reply {
  items?: CompletionItem[]
}

/** Gateway requests answered by hand, in any order. */
const pending: PromiseWithResolvers<Reply>[] = []

function setup() {
  const gw = {
    request: () => {
      const reply = Promise.withResolvers<Reply>()
      pending.push(reply)

      return reply.promise
    }
  }

  const host = { changed: vi.fn(), close: vi.fn(), open: vi.fn() }
  const completion = new Completion(host, gw as unknown as GatewayClient, () => 'sid')
  const composer = new Composer()

  return { completion, composer }
}

/** Types `text` and lets the debounce fire its request. */
function type(completion: Completion, composer: Composer, text: string) {
  composer.insert(text)
  completion.update(composer)
  vi.advanceTimersByTime(100)
}

const row = (text: string): CompletionItem => ({ display: text, text })
const escape = { alt: false, ctrl: false, meta: false, name: 'escape', shift: false } satisfies Key

beforeEach(() => {
  pending.length = 0
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Completion', () => {
  it('drops a reply that lands after Esc dismissed the list', async () => {
    const { completion, composer } = setup()
    type(completion, composer, '/h')
    pending[0]?.resolve({ items: [row('/help')] })
    await vi.runAllTimersAsync()
    expect(completion.open).toBe(true)

    type(completion, composer, 'e')
    expect(completion.onKey(escape)).toBe(true)
    pending[1]?.resolve({ items: [row('/help')] })
    await vi.runAllTimersAsync()
    expect(completion.open).toBe(false)
  })

  it('drops a reply that lands after dismiss() (a modal opened)', async () => {
    const { completion, composer } = setup()
    type(completion, composer, '/h')
    completion.dismiss()
    pending[0]?.resolve({ items: [row('/help')] })
    await vi.runAllTimersAsync()
    expect(completion.open).toBe(false)
  })

  it('an older request failing does not close the newer list', async () => {
    const { completion, composer } = setup()
    type(completion, composer, '/h')
    type(completion, composer, 'e')
    pending[1]?.resolve({ items: [row('/help')] })
    await vi.runAllTimersAsync()
    pending[0]?.reject(new Error('late'))
    await vi.runAllTimersAsync()
    expect(completion.items.map(i => i.text)).toEqual(['/help'])
  })

  it('Tab on a list answering older text leaves the newer text alone', async () => {
    const { completion, composer } = setup()
    type(completion, composer, '/h')
    pending[0]?.resolve({ items: [row('/help')] })
    await vi.runAllTimersAsync()
    // A key outran the render: the text changed but the list was not refreshed yet.
    composer.insert('x')
    expect(completion.onKey({ ...escape, name: 'tab' })).toBe(false)
    expect(composer.text).toBe('/hx')
    expect(completion.ghost).toBe('')
  })
})
