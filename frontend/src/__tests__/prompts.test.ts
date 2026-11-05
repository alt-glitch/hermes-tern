import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import type { NodeJson } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { sharedPromptRequest } from '../hermes/sharedPrompts.js'
import type { Overlay, OverlayHost } from '../overlays/overlay.js'
import { confirmOverlay, promptOverlay, promptTimeoutNotice } from '../overlays/prompts.js'
import { parsePrompt, type PromptRequest } from '../prompts/parse.js'
import { promptKey, PromptSheets } from '../prompts/sheets.js'

import { key, must, spanTexts, stub, tree } from './fakes.js'
import { nativeBrowserSurface } from './browserSdk.js'
import { assignedRoot } from './overlayRoots.js'

const ctrlC = key('c', { ctrl: true })

/** `req` read as the sheets read it. */
function parsed(req: ServerRequest): PromptRequest {
  const prompt = parsePrompt(req)

  if (!prompt) {
    throw new Error(`no prompt for ${req.method}`)
  }

  return prompt
}

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

  const overlay = promptOverlay(host, parsed(req))

  if (!overlay) {
    throw new Error(`no sheet for ${method}`)
  }

  return { answers, closed, overlay }
}

/** The `text` the sheet's input shows (masked or not), found in its node tree. */
function inputText(overlay: Overlay): unknown {
  const walk = (n: NodeJson): unknown => (n.k === 'input' ? n.p?.['text'] : (n.c ?? []).map(walk).find(t => t !== undefined))

  return walk(tree(overlay.node(assignedRoot(overlay))))
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
    const walk = (n: NodeJson): unknown[] =>
      n.p?.['role'] === 'omp.btn'
        ? [{ keys: (n.c ?? []).map(c => c.p?.['keys']).find(Boolean), label: n.c?.[0]?.p?.['text'], primary: n.p['tone'] === 'accent' }]
        : (n.c ?? []).flatMap(walk)

    return walk(tree(overlay.node(assignedRoot(overlay))))
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

  it.each(['enter', 'y', 'a', 's'])('ignores modified affirmative %s before accepting a bare choice', name => {
    const { answers, overlay } = open('approval', { command: 'make' })
    for (const mods of [{ ctrl: true }, { alt: true }, { meta: true }, { shift: true }, { ctrl: true, alt: true }]) {
      expect(overlay.onKey(key(name, mods))).toBe(true)
    }
    overlay.onKey(key('escape', { alt: true }))
    expect(answers).toEqual([])
    overlay.onKey(key(name))
    expect(answers).toHaveLength(1)
  })

  it('still accepts a native click for an explicitly offered approval', async () => {
    const { answers, overlay } = open('approval', { command: 'make' })
    const sdk = await nativeBrowserSurface()
    try {
      const click = sdk.capture(sdk.render('layer', overlay.node(assignedRoot(overlay))), 'layer', 'once')
      await click()
      expect(answers).toEqual([{ choice: 'once' }])
    } finally {
      await sdk.close()
    }
  })

  it('shows the whole command, wrapped', () => {
    const command = `cd /home/x/worktree && ${'for f in a b c; do echo $f; done && '.repeat(6)}true`
    const { overlay } = open('approval', { command })
    const tree = JSON.stringify(overlay.node(assignedRoot(overlay)))

    expect(tree).toContain(JSON.stringify(command))
    expect(tree).toMatch(/"wrap":true/)
  })
})

describe('masked prompts', () => {
  it('keeps a value on modified Enter and Escape until a bare submission', () => {
    const { answers, overlay } = open('vault.code', { hint: 'sent by SMS', site: 'example.com' })
    overlay.onKey(key('1', { text: '1' }))
    for (const mods of [{ ctrl: true }, { alt: true }, { meta: true }, { shift: true }, { ctrl: true, alt: true }]) {
      overlay.onKey(key('enter', mods))
      overlay.onKey(key('escape', mods))
    }
    expect(answers).toEqual([])
    expect(inputText(overlay)).toBe('1')
    overlay.onKey(key('enter'))
    expect(answers).toEqual([{ value: '1' }])
  })

  it('does not advance a multi-field login on modified Enter', () => {
    const { answers, overlay } = open('vault.save_login', { site: 'example.com' })
    overlay.onKey(key('a', { text: 'a' }))
    overlay.onKey(key('enter', { ctrl: true }))
    overlay.onKey(key('b', { text: 'b' }))
    overlay.onKey(key('enter'))
    overlay.onKey(key('p', { text: 'p' }))
    overlay.onKey(key('enter'))
    expect(answers).toEqual([{ value: JSON.stringify({ identifier: 'ab', password: 'p' }) }])
  })
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

describe('clarify input and ordinary confirmation', () => {
  it('keeps modified Enter and option numbers from answering, while bare Enter answers', () => {
    const { answers, overlay } = open('clarify', { questions: [{ qid: 'q1', question: 'Which?', choices: ['first', 'second'] }] })
    for (const mods of [{ ctrl: true }, { alt: true }, { meta: true }, { shift: true }, { ctrl: true, alt: true }]) {
      overlay.onKey(key('enter', mods))
      overlay.onKey(key('1', mods))
    }
    expect(answers).toEqual([])
    overlay.onKey(key('enter'))
    expect(answers).toEqual([{ answers: { q1: 'first' } }])
  })

  it('keeps free-text editing on Shift+Enter without submitting', () => {
    const { answers, overlay } = open('clarify', { questions: [{ qid: 'q1', question: 'Why?' }] })
    overlay.onKey(key('x', { text: 'x' }))
    overlay.onKey(key('enter', { shift: true }))
    overlay.onKey(key('z', { text: 'z' }))
    expect(answers).toEqual([])
    expect(inputText(overlay)).toBe('x\nz')
    overlay.onKey(key('enter'))
    expect(answers).toEqual([{ answers: { q1: 'x\nz' } }])
  })

  it('consumes modified keys and lets an explicit native click confirm once', async () => {
    const confirm = vi.fn()
    const host: OverlayHost = { changed: vi.fn(), close: vi.fn(), open: vi.fn() }
    const overlay = confirmOverlay(host, { title: 'Stop?', detail: '', confirm: 'Stop', onConfirm: confirm })
    for (const name of ['y', 'enter', 'n', 'escape']) {
      overlay.onKey(key(name, { ctrl: true, alt: true }))
    }
    expect(confirm).not.toHaveBeenCalled()
    expect(host.close).not.toHaveBeenCalled()
    const sdk = await nativeBrowserSurface()
    try {
      const click = sdk.capture(sdk.render('layer', overlay.node(assignedRoot(overlay))), 'layer', 'ok')
      await click()
      await click()
      expect(confirm).toHaveBeenCalledTimes(1)
    } finally {
      await sdk.close()
    }
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

  const req = must(sharedPromptRequest(
    { payload: { execution_generation: 3, prompt_id: 'p1', ...payload }, session_id: 's1', type },
    stub({ request }),
    m => notices.push(m)
  ))

  const closed: Overlay[] = []
  const host: OverlayHost = { changed: () => undefined, close: o => closed.push(o), open: () => undefined }
  const overlay = must(promptOverlay(host, parsed(req)))

  return { closed, notices, overlay, replies, req, request }
}

/** Every text span the sheet shows, joined. */
function sheetText(overlay: Overlay): string {
  const walk = (n: NodeJson): string[] => [
    ...(typeof n.p?.['text'] === 'string' ? [n.p['text']] : []),
    ...spanTexts(n.p?.['spans']),
    ...(n.c ?? []).flatMap(walk)
  ]

  return walk(tree(overlay.node(assignedRoot(overlay)))).join(' ')
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('a shared prompt sheet', () => {
  it('freezes modified input during a pending reply and restores multiline editing after refusal', async () => {
    const { closed, overlay, replies, request } = shared('clarify.request', { question: 'Why?' })

    overlay.onKey(key('a', { text: 'a' }))
    overlay.onKey(key('enter'))
    overlay.onKey(key('enter', { shift: true }))
    overlay.onKey(key('enter', { alt: true }))
    overlay.onKey(key('enter', { ctrl: true }))
    overlay.onKey(key('c', { ctrl: true, alt: true }))
    overlay.cancel?.() // The App's global bare Ctrl+C path calls cancel directly.
    overlay.onKey(key('b', { text: 'b' }))
    expect(inputText(overlay)).toBe('a')
    expect(request).toHaveBeenCalledTimes(1)
    expect(closed).toEqual([])

    must(replies[0]).reject(new Error('gateway unavailable'))
    await settle()
    overlay.onKey(key('c', { ctrl: true, alt: true }))
    overlay.onKey(key('enter', { shift: true }))
    overlay.onKey(key('b', { text: 'b' }))
    overlay.onKey(key('enter', { ctrl: true }))
    expect(inputText(overlay)).toBe('a\nb')
    expect(request).toHaveBeenCalledTimes(1)
    overlay.onKey(key('enter'))
    expect(request).toHaveBeenLastCalledWith('clarify.respond', expect.objectContaining({ answer: 'a\nb' }))
    must(replies[1]).resolve({ status: 'resolved' })
    await settle()
  })

  it('keeps the submitted text unchanged while the gateway is deciding, then permits editing after refusal', async () => {
    const { overlay, replies, request } = shared('clarify.request', { question: 'Why?' })

    overlay.onKey(key('a', { text: 'a' }))
    overlay.onKey(key('enter'))
    overlay.onKey(key('b', { text: 'b' }))
    overlay.onKey(key('escape'))
    expect(inputText(overlay)).toBe('a')
    expect(request).toHaveBeenCalledTimes(1)

    must(replies[0]).reject(new Error('gateway unavailable'))
    await settle()
    overlay.onKey(key('b', { text: 'b' }))
    expect(inputText(overlay)).toBe('ab')
    overlay.onKey(key('enter'))
    expect(request).toHaveBeenLastCalledWith('clarify.respond', expect.objectContaining({ answer: 'ab' }))
    must(replies[1]).resolve({ status: 'resolved' })
    await settle()
  })

  it('does not let keys change a submitted batch while its answer is in flight', async () => {
    const replies: PromiseWithResolvers<unknown>[] = []
    const respond = vi.fn(() => {
      const reply = Promise.withResolvers<unknown>()
      replies.push(reply)
      return reply.promise
    })
    const req: ServerRequest = {
      id: 'batch', method: 'clarify', fail: () => undefined, respond,
      params: { questions: [
        { qid: 'one', question: 'First?', choices: ['A', 'B'] },
        { qid: 'two', question: 'Second?', choices: ['C', 'D'] }
      ] }
    }
    const host: OverlayHost = { changed: () => undefined, close: () => undefined, open: () => undefined }
    const overlay = must(promptOverlay(host, parsed(req)))

    overlay.onKey(key('1'))
    expect(respond).not.toHaveBeenCalled()
    overlay.onKey(key('enter'))
    overlay.onKey(key('2'))
    expect(respond).not.toHaveBeenCalled()
    overlay.onKey(key('enter'))
    expect(respond).toHaveBeenCalledWith({ answers: { one: 'A', two: 'D' } })
    overlay.onKey(key('tab'))
    overlay.onKey(key('2'))
    expect(respond).toHaveBeenCalledTimes(1)

    must(replies[0]).reject(new Error('gateway unavailable'))
    await settle()
    overlay.onKey(key('enter'))
    expect(respond).toHaveBeenLastCalledWith({ answers: { one: 'A', two: 'D' } })
    must(replies[1]).resolve({})
    await settle()
  })

  it('closes only once approval.respond lands', async () => {
    const { closed, overlay, replies, request } = shared('approval.request', { command: 'rm -rf build' })

    overlay.onKey(key('y'))
    expect(request).toHaveBeenCalledWith('approval.respond', { choice: 'once', execution_generation: 3, prompt_id: 'p1', session_id: 's1' })
    expect(closed).toEqual([])
    expect(sheetText(overlay)).toMatch(/Sending/)

    // A second answer while the first is in flight sends nothing.
    overlay.onKey(key('n'))
    expect(request).toHaveBeenCalledTimes(1)

    must(replies[0]).resolve({ status: 'resolved' })
    await settle()
    expect(closed).toEqual([overlay])
  })

  it('stays open with the reason when the answer is refused, and answers again', async () => {
    const { closed, overlay, replies, request } = shared('approval.request', { command: 'make' })

    overlay.onKey(key('y'))
    must(replies[0]).reject(new Error('gateway unavailable'))
    await settle()

    expect(closed).toEqual([])
    expect(sheetText(overlay)).toMatch(/Not answered: gateway unavailable/)

    overlay.onKey(key('n'))
    expect(request).toHaveBeenLastCalledWith('approval.respond', expect.objectContaining({ choice: 'deny' }))
    must(replies[1]).resolve({ status: 'resolved' })
    await settle()
    expect(closed).toEqual([overlay])
  })

  it('closes unanswered on Esc after a refusal (a retry may never land)', async () => {
    const { closed, overlay, replies, request } = shared('clarify.request', { question: 'Which?' })

    overlay.onKey(key('a', { text: 'a' }))
    overlay.onKey(key('enter'))
    expect(request).toHaveBeenCalledWith('clarify.respond', expect.objectContaining({ answer: 'a' }))
    must(replies[0]).reject(new Error('stale_generation'))
    await settle()
    expect(closed).toEqual([])

    overlay.onKey(key('escape'))
    expect(closed).toEqual([overlay])
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('says so when the question was already answered elsewhere', async () => {
    const { closed, notices, overlay, replies } = shared('approval.request', { command: 'make' })

    overlay.onKey(key('y'))
    must(replies[0]).resolve({ status: 'already_resolved' })
    await settle()

    expect(closed).toEqual([overlay])
    expect(notices).toEqual(['That question was already answered (by another window, or it timed out).'])
  })
})

describe('PromptSheets', () => {
  /** A stack the way App keeps it: open replaces a same-key overlay, close tells the sheets. */
  function stack() {
    const overlays: Overlay[] = []
    const closed: string[] = []

    const sheets: PromptSheets = new PromptSheets({
      close: o => {
        const at = overlays.indexOf(o)

        if (at >= 0) {
          overlays.splice(at, 1)
          sheets.closed(o)
          closed.push(o.key)
        }
      },
      open: o => void overlays.push(o),
      overlays
    })

    const sheet = (key: string): Overlay => ({ ...open('sudo', {}).overlay, key })
    const request = (id: string, method = 'clarify', params: Record<string, unknown> = {}): ServerRequest => ({ fail: () => undefined, id, method, params, respond: () => undefined })
    const show = (id: string, method?: string, params?: Record<string, unknown>) => sheets.open(sheet(promptKey(id)), parsed(request(id, method, params)))
    const keys = () => overlays.map(o => o.key)

    return { closed, keys, overlays, sheet, sheets, show }
  }

  it('keys a sheet by its request id, as each prompt overlay does', () => {
    expect(promptKey('r1')).toBe('prompt:r1')
    expect(open('approval', { command: 'ls' }).overlay.key).toBe(promptKey('r1'))
    expect(open('sudo', {}).overlay.key).toBe(promptKey('r1'))
  })

  it('drop closes the sheet for one request id, and shows says whether it is open', () => {
    const { keys, sheets, show } = stack()
    show('r1')
    show('r2')

    expect(sheets.shows('r1')).toBe(true)
    sheets.drop('r1')

    expect(keys()).toEqual(['prompt:r2'])
    expect(sheets.shows('r1')).toBe(false)
  })

  it('dropShared closes every shared prompt\'s sheet and keeps a legacy request\'s', () => {
    const { keys, sheets, show } = stack()
    show('shared:p1')
    show('r1')
    show('shared:p2')

    sheets.dropShared()

    expect(keys()).toEqual(['prompt:r1'])
  })

  it('dropAll closes every prompt sheet and leaves the other overlays', () => {
    const { keys, overlays, sheet, sheets, show } = stack()
    show('r1')
    overlays.push(sheet('help'))
    show('shared:p1')

    sheets.dropAll()

    expect(keys()).toEqual(['help'])
  })

  it('dropByApproval closes the approvals whose queue ids it names', () => {
    const { keys, sheets, show } = stack()
    show('r1', 'approval', { request_id: 'q1' })
    show('r2', 'approval', { request_id: 'q2' })
    show('r3')

    sheets.dropByApproval(['q2', 'q9'])
    expect(keys()).toEqual(['prompt:r1', 'prompt:r3'])

    sheets.dropByApproval(undefined)
    expect(keys()).toEqual(['prompt:r1', 'prompt:r3'])
  })

  it('a closed approval forgets its queue id: a sheet that takes its key after it is not that approval', () => {
    const { closed, keys, sheets, show } = stack()
    show('r1', 'approval', { request_id: 'q1' })
    sheets.drop('r1')
    show('r1', 'sudo')

    sheets.dropByApproval(['q1'])

    expect(keys()).toEqual(['prompt:r1'])
    expect(closed).toEqual(['prompt:r1'])
  })
})
