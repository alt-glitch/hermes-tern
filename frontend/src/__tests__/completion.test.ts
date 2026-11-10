import type { CompletionItem } from '@hermes/shared/gateway-events'
import { Node, Surface, type Key } from '@stencil-hq/tern'
import type { GatewayClient } from '@hermes/shared/gateway-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Composer } from '../draft/composer.js'
import { completionRequestForInput } from '../hermes/completion.js'
import { Completion } from '../overlays/completion.js'

import { stub, tree } from './fakes.js'

const history: string[] = []

vi.mock('@hermes/shared/prompt-history', () => ({ append: () => undefined, load: () => history }))

interface Reply {
  items?: CompletionItem[]
  replace_from?: number
}

/** Gateway requests answered by hand, in any order. */
const pending: PromiseWithResolvers<Reply>[] = []

function setup() {
  let owner: object = {}
  let sid = 'sid'
  const requests: unknown[] = []
  const gw = {
    request: (method: string, params: unknown) => {
      requests.push({ method, params })
      const reply = Promise.withResolvers<Reply>()
      pending.push(reply)

      return reply.promise
    }
  }

  const host = { changed: vi.fn(), close: vi.fn(), open: vi.fn() }
  const completion = new Completion(host, stub<GatewayClient>(gw), () => sid, () => owner)
  const composer = new Composer()

  return { completion, composer, requests, changeSession: (next: string) => { sid = next; owner = {} } }
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
    expect(completion.onKey({ ...escape, name: 'tab' })).toBe(true)
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

  it('replaces the entire path token when the caret is in its middle', async () => {
    const { completion, composer } = setup()
    composer.set('see @app.ts next', { cursor: 8 })
    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[0]?.resolve({ items: [row('@file:src/app.ts')] })
    await vi.runAllTimersAsync()

    expect(completion.onKey(tab)).toBe(true)
    expect(composer.text).toBe('see @file:src/app.ts next')
    expect(composer.cursor).toBe(21)
    composer.undo()
    expect(composer.text).toBe('see @app.ts next')
    expect(composer.cursor).toBe(8)
  })

  it('keeps prior lines and later arguments while replacing the active skill', async () => {
    const { completion, composer } = setup()
    composer.set('😀 first\nuse /skilled afterwards', { cursor: '😀 first\nuse /sk'.length })
    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[0]?.resolve({ items: [{ ...row('/skill'), kind: 'skill' }] })
    await vi.runAllTimersAsync()
    expect(completion.onKey(tab)).toBe(true)
    expect(composer.text).toBe('😀 first\nuse /skill afterwards')
  })

  it('honors Python code-point slash offsets after non-BMP text', async () => {
    const { completion, composer } = setup()
    composer.set('/cron 😀 add next', { cursor: '/cron 😀 ad'.length })
    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[0]?.resolve({ items: [row('add')], replace_from: 8 })
    await vi.runAllTimersAsync()
    expect(completion.onKey(tab)).toBe(true)
    expect(composer.text).toBe('/cron 😀 add next')
  })

  it('does not alter an ambiguous quoted or escaped token', async () => {
    const { completion, composer } = setup()
    composer.set('see @app\\ name rest', { cursor: 8 })
    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[0]?.resolve({ items: [row('@file:app')] })
    await vi.runAllTimersAsync()
    expect(completion.onKey(tab)).toBe(true)
    expect(composer.text).toBe('see @app\\ name rest')
  })

  it('does not accept stale rows after suffix edits or a session ABA', async () => {
    const { completion, composer, changeSession } = setup()
    composer.set('see @app.ts', { cursor: 8 })
    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[0]?.resolve({ items: [row('@file:app.ts')] })
    await vi.runAllTimersAsync()
    changeSession('other')
    changeSession('sid')
    expect(completion.onKey(tab)).toBe(true)
    expect(composer.text).toBe('see @app.ts')

    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[1]?.resolve({ items: [row('@file:app.ts')] })
    await vi.runAllTimersAsync()
    composer.set('see @app.js', { cursor: 8 })
    expect(completion.onKey(tab)).toBe(true)
    expect(composer.text).toBe('see @app.js')
  })

  it('drops a session switch before debounce without issuing a request', async () => {
    const { completion, composer, changeSession, requests } = setup()
    composer.set('@app')
    completion.update(composer)
    changeSession('other')
    await vi.advanceTimersByTimeAsync(100)
    expect(requests).toEqual([])
  })

  it('rejects a reply after a session changes away and back', async () => {
    const { completion, composer, changeSession } = setup()
    composer.set('@app')
    completion.update(composer)
    vi.advanceTimersByTime(100)
    changeSession('other')
    changeSession('sid')
    pending[0]?.resolve({ items: [row('@file:app')] })
    await vi.runAllTimersAsync()
    expect(completion.open).toBe(false)
    expect(composer.text).toBe('@app')
  })

  it('preserves an active selection and rejects a malformed server offset', async () => {
    const { completion, composer } = setup()
    composer.set('/help')
    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[0]?.resolve({ items: [row('/help')], replace_from: 0 })
    await vi.runAllTimersAsync()
    expect(completion.open).toBe(false)
    expect(composer.text).toBe('/help')

    composer.set('/he')
    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[1]?.resolve({ items: [row('help')], replace_from: 3 })
    await vi.runAllTimersAsync()
    expect(completion.open).toBe(false)
    expect(composer.text).toBe('/he')

    composer.set('/tools di')
    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[2]?.resolve({ items: [row('disable')] })
    await vi.runAllTimersAsync()
    expect(completion.open).toBe(false)
    expect(composer.text).toBe('/tools di')

    composer.set('@app')
    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[3]?.resolve({ items: [row('@file:app')] })
    await vi.runAllTimersAsync()
    composer.edit({ from: 4, to: 4, text: '', cursor: 4, len: 4, raw: { anchor: 1 } })
    expect(completion.onKey(tab)).toBe(true)
    expect(composer.text).toBe('@app')
    expect(composer.anchor).toBe(1)
  })

  it('applies the same token range through native pointer activation', async () => {
    const { completion, composer } = setup()
    composer.set('see @app.ts next', { cursor: 8 })
    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[0]?.resolve({ items: [row('@file:src/app.ts')] })
    await vi.runAllTimersAsync()
    const root = completion.nodes('composer')[0]
    if (!(root instanceof Node) || !(root.children[0] instanceof Node) || !(root.children[0].children[0] instanceof Node)) {
      throw new Error('completion list missing')
    }
    const id = `layer.${String(root.props['key'])}.select.list`
    root.children[0].children[0].handlers?.['onActivate']?.({ ev: 'activate', sf: 'hermes', id, raw: {}, item: `${id}.0` })
    expect(composer.text).toBe('see @file:src/app.ts next')
  })

  it('Enter completes a changed mid-token command but submits an already-complete one', async () => {
    const { completion, composer } = setup()
    composer.set('/helper next', { cursor: 5 })
    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[0]?.resolve({ items: [row('/help')], replace_from: 1 })
    await vi.runAllTimersAsync()
    expect(completion.onKey({ ...escape, name: 'enter' })).toBe(true)
    expect(composer.text).toBe('/help next')

    composer.set('/help next', { cursor: 5 })
    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[1]?.resolve({ items: [row('/help ')], replace_from: 1 })
    await vi.runAllTimersAsync()
    expect(completion.onKey({ ...escape, name: 'enter' })).toBe(false)
    expect(composer.text).toBe('/help next')
  })

  it('refuses to consume a descendant path or split a grapheme', async () => {
    const { completion, composer } = setup()
    composer.set('open ./foo/child.ts', { cursor: 'open ./fo'.length })
    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[0]?.resolve({ items: [row('./foo/')] })
    await vi.runAllTimersAsync()
    expect(completion.onKey(tab)).toBe(true)
    expect(composer.text).toBe('open ./foo/child.ts')

    composer.set('see @😀end', { cursor: 'see @'.length + 1 })
    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[1]?.resolve({ items: [row('@file:x')] })
    await vi.runAllTimersAsync()
    expect(completion.onKey(tab)).toBe(true)
    expect(composer.text).toBe('see @😀end')
  })

  it('leaves slash argument descendants and ambiguous punctuation untouched', async () => {
    const { completion, composer } = setup()
    composer.set('/tools disable foo/bar', { cursor: '/tools disable fo'.length })
    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[0]?.resolve({ items: [row('foo')], replace_from: 15 })
    await vi.runAllTimersAsync()
    expect(completion.onKey(tab)).toBe(true)
    expect(composer.text).toBe('/tools disable foo/bar')

    composer.set('see @file!', { cursor: 'see @fi'.length })
    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[1]?.resolve({ items: [row('@file:file')] })
    await vi.runAllTimersAsync()
    expect(completion.onKey(tab)).toBe(true)
    expect(composer.text).toBe('see @file!')
  })

  it('does not consume modified Enter when an answer goes stale', async () => {
    const { completion, composer } = setup()
    composer.set('@app')
    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[0]?.resolve({ items: [row('@file:app')] })
    await vi.runAllTimersAsync()
    composer.insert('x')
    expect(completion.onKey({ ...escape, name: 'enter', shift: true })).toBe(false)
    expect(completion.onKey({ ...escape, name: 'enter', alt: true })).toBe(false)
    expect(composer.text).toBe('@appx')
  })

  it('invalidates an old pointer callback and hides its list when the draft changes', async () => {
    const { completion, composer } = setup()
    composer.set('@app')
    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[0]?.resolve({ items: [row('@file:app')] })
    await vi.runAllTimersAsync()
    const root = completion.nodes('composer')[0]
    if (!(root instanceof Node) || !(root.children[0] instanceof Node) || !(root.children[0].children[0] instanceof Node)) {
      throw new Error('completion list missing')
    }
    const activate = root.children[0].children[0].handlers?.['onActivate']
    const id = `layer.${String(root.props['key'])}.select.list`
    composer.insert('x')
    completion.update(composer)
    expect(completion.open).toBe(false)
    activate?.({ ev: 'activate', sf: 'hermes', id, raw: {}, item: `${id}.0` })
    expect(composer.text).toBe('@appx')
  })

  it('does not route an old native list id to a newer answer', async () => {
    const { completion, composer } = setup()
    const surface = new Surface({ send: () => undefined, credits: () => 1, dropped: () => undefined }, 'test', { listen: false })
    composer.set('@app')
    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[0]?.resolve({ items: [row('@file:app')] })
    await vi.runAllTimersAsync()
    const old = completion.nodes('composer')[0]
    if (!(old instanceof Node)) { throw new Error('completion missing') }
    const oldId = `layer.${String(old.props['key'])}.select.list`
    surface.render({ layer: [old] })

    composer.insert('x')
    completion.update(composer)
    vi.advanceTimersByTime(100)
    pending[1]?.resolve({ items: [row('@file:appx')] })
    await vi.runAllTimersAsync()
    surface.render({ layer: completion.nodes('composer') })
    const event = { ev: 'activate', sf: 'test', id: oldId, item: `${oldId}.0`, raw: {} } as const
    expect(surface.dispatch(event)).toBeUndefined()
    expect(composer.text).toBe('@appx')
  })

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
