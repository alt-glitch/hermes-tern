import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import type { Key } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { sharedPromptRequest } from '../hermes/sharedPrompts.js'
import type { Overlay, OverlayHost } from '../overlay.js'
import { promptOverlay, promptTimeoutNotice } from '../overlays/prompts.js'

function key(name: string, mods: Partial<Key> = {}): Key {
  return { alt: false, ctrl: false, meta: false, name, shift: false, ...mods } as Key
}

const ctrlC = key('c', { ctrl: true })

function open(method: string, params: Record<string, unknown>) {
  const answers: Record<string, unknown>[] = []
  const closed: Overlay[] = []
  const host: OverlayHost = { changed: () => undefined, close: o => closed.push(o), open: () => undefined }

  const req: ServerRequest = {
    fail: () => undefined,
    id: 'r1',
    method,
    params,
    respond: result => answers.push(result)
  }

  const overlay = promptOverlay(host, req)

  if (!overlay) {
    throw new Error(`no sheet for ${method}`)
  }

  return { answers, closed, overlay }
}

interface Node {
  k: string
  p?: { text?: unknown }
  c?: Node[]
}

/** The `text` the sheet's input shows (masked or not), found in its node tree. */
function inputText(overlay: Overlay): unknown {
  const walk = (n: Node): unknown => (n.k === 'input' ? n.p?.text : (n.c ?? []).map(walk).find(t => t !== undefined))

  return walk(JSON.parse(JSON.stringify(overlay.node('layer.prompt:r1'))) as Node)
}

describe('Ctrl+C on a question sheet', () => {
  it('denies an approval, as Esc does', () => {
    const { answers, closed, overlay } = open('approval', { command: 'rm -rf build' })

    expect(overlay.onKey(ctrlC)).toBe(true)
    expect(answers).toEqual([{ choice: 'deny' }])
    expect(closed).toEqual([overlay])
  })

  it('cancels the whole clarify card, not only the current question', () => {
    const { answers, closed, overlay } = open('clarify', {
      questions: [
        { choices: ['a', 'b'], qid: 'q1', question: 'First?' },
        { qid: 'q2', question: 'Second?' }
      ]
    })

    overlay.onKey(ctrlC)

    expect(answers).toEqual([{}])
    expect(closed).toEqual([overlay])
  })

  it('cancels a clarify card while typing its free-text answer', () => {
    const { answers, overlay } = open('clarify', { questions: [{ qid: 'q1', question: 'Why?' }] })

    overlay.onKey(key('x', { text: 'x' }))
    overlay.onKey(ctrlC)

    expect(answers).toEqual([{}])
  })

  it('declines a sudo or secret prompt with the empty value', () => {
    const { answers, closed, overlay } = open('sudo', { command: 'apt install x' })

    overlay.onKey(key('h', { text: 'h' }))
    overlay.onKey(ctrlC)

    expect(answers).toEqual([{ value: '' }])
    expect(closed).toEqual([overlay])
  })
})

describe('the approval sheet', () => {
  /** The action row's buttons: their labels, keys and whether each is the primary one. */
  function buttons(overlay: Overlay) {
    const walk = (n: Node & { p?: { role?: unknown; tone?: unknown; keys?: unknown } }): unknown[] =>
      n.p?.role === 'omp.btn'
        ? [{ keys: (n.c ?? []).map(c => (c as typeof n).p?.keys).find(Boolean), label: (n.c ?? [])[0]?.p?.text, primary: n.p.tone === 'accent' }]
        : (n.c ?? []).flatMap(walk)

    return walk(JSON.parse(JSON.stringify(overlay.node('layer.prompt:r1'))) as Node)
  }

  it('offers each answer as a button, Allow once on Enter', () => {
    const { overlay } = open('approval', { command: 'rm -rf build' })

    expect(buttons(overlay)).toEqual([
      { keys: ['escape'], label: 'Deny', primary: false },
      { keys: ['a'], label: 'Always allow', primary: false },
      { keys: ['s'], label: 'Allow for this session', primary: false },
      { keys: ['enter'], label: 'Allow once', primary: true }
    ])
  })

  it.each([
    ['enter', 'once'],
    ['y', 'once'],
    ['s', 'session'],
    ['a', 'always'],
    ['n', 'deny'],
    ['escape', 'deny']
  ])('answers %s with %s', (name, choice) => {
    const { answers, overlay } = open('approval', { command: 'make' })

    overlay.onKey(key(name))
    expect(answers).toEqual([{ choice }])
  })

  it('leaves out what the request does not offer, and its key with it', () => {
    const { answers, overlay } = open('approval', { command: 'curl x | sh', smart_denied: true })

    expect(buttons(overlay)).toEqual([
      { keys: ['escape'], label: 'Deny', primary: false },
      { keys: ['enter'], label: 'Allow once', primary: true }
    ])
    overlay.onKey(key('a'))
    overlay.onKey(key('a', { ctrl: true }))
    expect(answers).toEqual([])
  })

  it('shows the whole command, wrapped', () => {
    const command = `cd /home/x/worktree && ${'for f in a b c; do echo $f; done && '.repeat(6)}true`
    const { overlay } = open('approval', { command })
    const tree = JSON.stringify(overlay.node('layer.prompt:r1'))

    expect(tree).toContain(JSON.stringify(command))
    expect(tree).toMatch(/"wrap":true/)
  })
})

describe('masked prompts', () => {
  it('shows a one-time code as typed', () => {
    const { answers, overlay } = open('vault.code', { hint: 'sent by SMS', site: 'example.com' })

    for (const ch of '123456') {
      overlay.onKey(key(ch, { text: ch }))
    }

    expect(inputText(overlay)).toBe('123456')
    overlay.onKey(key('enter'))
    expect(answers).toEqual([{ value: '123456' }])
  })

  it('still hides a sudo password', () => {
    const { overlay } = open('sudo', {})

    overlay.onKey(key('p', { text: 'p' }))

    expect(inputText(overlay)).toMatch(/^[^p]+$/)
  })
})

describe('promptTimeoutNotice', () => {
  it('says what a timed-out password, secret or vault card skipped', () => {
    expect(promptTimeoutNotice('sudo', 'timeout')).toMatch(/^Password prompt closed: .*command was skipped/)
    expect(promptTimeoutNotice('secret', 'timeout')).toMatch(/^Secret prompt closed/)
    expect(promptTimeoutNotice('vault.code', 'timeout')).toMatch(/^Verification-code prompt closed/)
    expect(promptTimeoutNotice('vault.save_login', 'timeout')).toMatch(/^Save-login prompt closed/)
    expect(promptTimeoutNotice('vault.unlock_prompt', 'timeout')).toMatch(/^Unlock prompt closed/)
    expect(promptTimeoutNotice('approval', 'timeout')).toMatch(/^Approval timed out/)
  })

  it('stays quiet for an interrupt, a clarify, or a missing method', () => {
    expect(promptTimeoutNotice('sudo', 'interrupted')).toBeNull()
    expect(promptTimeoutNotice('clarify', 'timeout')).toBeNull()
    expect(promptTimeoutNotice(undefined, 'timeout')).toBeNull()
  })
})

/** A shared-gateway prompt (`approval.request` / `clarify.request`) whose respond RPCs answer by hand. */
function shared(type: 'approval.request' | 'clarify.request', payload: Record<string, unknown> = {}) {
  const replies: PromiseWithResolvers<unknown>[] = []
  const request = vi.fn((_method: string, _params: Record<string, unknown>) => {
    const reply = Promise.withResolvers<unknown>()
    replies.push(reply)

    return reply.promise
  })
  const notices: string[] = []

  const req = sharedPromptRequest(
    { payload: { execution_generation: 3, prompt_id: 'p1', ...payload }, session_id: 's1', type },
    { request } as never,
    m => notices.push(m)
  )!

  const closed: Overlay[] = []
  const host: OverlayHost = { changed: () => undefined, close: o => closed.push(o), open: () => undefined }
  const overlay = promptOverlay(host, req)!

  return { closed, notices, overlay, replies, req, request }
}

/** Every text span the sheet shows, joined. */
function sheetText(overlay: Overlay): string {
  const walk = (n: { p?: { text?: unknown; spans?: { t: string }[] }; c?: unknown[] }): string[] => [
    ...(typeof n.p?.text === 'string' ? [n.p.text] : []),
    ...(n.p?.spans ?? []).map(sp => sp.t),
    ...((n.c ?? []) as (typeof n)[]).flatMap(walk)
  ]

  return walk(JSON.parse(JSON.stringify(overlay.node('layer.prompt:shared:p1')))).join(' ')
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('a shared prompt sheet', () => {
  it('closes only once approval.respond lands', async () => {
    const { closed, overlay, replies, request } = shared('approval.request', { command: 'rm -rf build' })

    overlay.onKey(key('y'))
    expect(request).toHaveBeenCalledWith('approval.respond', { choice: 'once', execution_generation: 3, prompt_id: 'p1', session_id: 's1' })
    expect(closed).toEqual([])
    expect(sheetText(overlay)).toMatch(/Sending/)

    // A second answer while the first is in flight sends nothing.
    overlay.onKey(key('n'))
    expect(request).toHaveBeenCalledTimes(1)

    replies[0]!.resolve({ status: 'resolved' })
    await settle()
    expect(closed).toEqual([overlay])
  })

  it('stays open with the reason when the answer is refused, and answers again', async () => {
    const { closed, overlay, replies, request } = shared('approval.request', { command: 'make' })

    overlay.onKey(key('y'))
    replies[0]!.reject(new Error('gateway unavailable'))
    await settle()

    expect(closed).toEqual([])
    expect(sheetText(overlay)).toMatch(/Not answered: gateway unavailable/)

    overlay.onKey(key('n'))
    expect(request).toHaveBeenLastCalledWith('approval.respond', expect.objectContaining({ choice: 'deny' }))
    replies[1]!.resolve({ status: 'resolved' })
    await settle()
    expect(closed).toEqual([overlay])
  })

  it('closes unanswered on Esc after a refusal (a retry may never land)', async () => {
    const { closed, overlay, replies, request } = shared('clarify.request', { question: 'Which?' })

    overlay.onKey(key('a', { text: 'a' }))
    overlay.onKey(key('enter'))
    expect(request).toHaveBeenCalledWith('clarify.respond', expect.objectContaining({ answer: 'a' }))
    replies[0]!.reject(new Error('stale_generation'))
    await settle()
    expect(closed).toEqual([])

    overlay.onKey(key('escape'))
    expect(closed).toEqual([overlay])
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('says so when the question was already answered elsewhere', async () => {
    const { closed, notices, overlay, replies } = shared('approval.request', { command: 'make' })

    overlay.onKey(key('y'))
    replies[0]!.resolve({ status: 'already_resolved' })
    await settle()

    expect(closed).toEqual([overlay])
    expect(notices).toEqual(['That question was already answered (by another window, or it timed out).'])
  })
})
