import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import type { Key } from '@stencil-hq/tern'
import { describe, expect, it } from 'vitest'

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
