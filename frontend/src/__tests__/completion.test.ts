import type { CompletionItem } from '@hermes/shared/gateway-events'
import type { Key } from '@stencil-hq/tern'
import type { GatewayClient } from '@tui/gatewayClient.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Composer } from '../draft/composer.js'
import { completionRequestForInput } from '../hermes/completion.js'
import { Completion } from '../overlays/completion.js'

import { stub, tree } from './fakes.js'

const history: string[] = []

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => history }))

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
  const completion = new Completion(host, stub<GatewayClient>(gw), () => 'sid')
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
  history.length = 0
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
    // This frontend's own /theme and /ps (alias /shells) hold `he` too.
    expect(completion.items.map(i => i.text)).toEqual(['/help', '/theme', '/ps'])
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

  it('leaves Up/Down to the prompt history while a recalled entry opened the list', async () => {
    history.push('/help', '/new')
    const { completion, composer } = setup()
    const up = { ...escape, name: 'up' }
    composer.key(up)
    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[0]?.resolve({ items: [row('/new'), row('/news')] })
    await vi.runAllTimersAsync()
    expect(completion.open).toBe(true)

    expect(completion.onKey(up)).toBe(false)
    expect(completion.onKey({ ...escape, name: 'down' })).toBe(false)
    composer.key(up)
    expect(composer.text).toBe('/help')

    // Typed text is a draft again: the list owns the arrows.
    composer.insert('x')
    expect(completion.onKey(up)).toBe(true)
  })
})

describe('Completion: accepting an @ mention', () => {
  const tab = { ...escape, name: 'tab' }

  async function pick(before: string, after: string, text: string) {
    const { completion, composer } = setup()
    composer.set(after, { cursor: 0 })
    type(completion, composer, before)
    pending[0]?.resolve({ items: [row(text)] })
    await vi.runAllTimersAsync()
    completion.onKey(tab)

    return { cursor: composer.cursor, text: composer.text }
  }

  it('a file ends the mention with one space', async () => {
    expect(await pick('see @app', '', '@file:src/app.ts')).toEqual({ cursor: 21, text: 'see @file:src/app.ts ' })
  })

  it('reuses a space already after the caret', async () => {
    expect(await pick('@app', ' now', '@file:src/app.ts')).toEqual({ cursor: 17, text: '@file:src/app.ts now' })
  })

  it('a folder stays open to pick inside it', async () => {
    expect(await pick('@sr', '', '@folder:src/')).toEqual({ cursor: 12, text: '@folder:src/' })
  })
})

describe('Completion: the rows', () => {
  async function rows(text: string, items: CompletionItem[]) {
    const { completion, composer } = setup()
    type(completion, composer, text)
    pending[0]?.resolve({ items })
    await vi.runAllTimersAsync()
    const col = completion.nodes('composer').map(tree)[0]?.c?.[0]

    return {
      items: (col?.c?.[0]?.c ?? []).map(n => ({ detail: n.p?.['detail'], role: n.p?.['role'] })),
      more: col?.c?.find(n => n.p?.['role'] === 'hermes.complete.more')?.p?.['text']
    }
  }

  const skill = (name: string, meta: string): CompletionItem => ({ display: name, kind: 'skill', meta, text: name })

  it("drops Hermes' ⚡ before a skill's description and tags each row by kind", async () => {
    const { items, more } = await rows('see /gi', [skill('/github-issue-triage', '⚡ Automated batch triage of issues')])

    expect(items).toEqual([{ detail: 'Automated batch triage of issues', role: 'hermes.complete.skill' }])
    expect(more).toBeUndefined()
  })

  it('shows the highlighted row whole under the list while a row is cut off', async () => {
    const long = `Automated batch triage of GitHub issues: ${'label, dedupe and route each one; '.repeat(3)}`
    const { more } = await rows('see /gi', [skill('/github-issue-triage', `⚡ ${long}`), skill('/gif', 'GIFs')])

    expect(more).toBe(long.trim())
  })
})

describe('completionRequestForInput', () => {
  const word = (input: string) => {
    const request = completionRequestForInput(input)

    return request?.method === 'complete.path' ? request.params.word : null
  }

  it('opens `@` only at the start of a word', () => {
    expect(word('daimon@daimon')).toBeNull()
    expect(word('mail me@x.com')).toBeNull()
    expect(word('@dai')).toBe('@dai')
    expect(word('see @src/app')).toBe('@src/app')
  })

  it('still completes paths that start a word', () => {
    expect(word('open ./src')).toBe('./src')
    expect(word('~/notes')).toBe('~/notes')
    expect(word('look at frontend/src')).toBe('frontend/src')
  })
})
