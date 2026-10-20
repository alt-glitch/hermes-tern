// A typed prompt's {!cmd} expansion: which prompts have commands to run, what expand() gives back
// for each kind, and the types the send path sees (a typed prompt with no {!cmd} is still typed).
import { describe, expect, expectTypeOf, it } from 'vitest'

import { type ExpandHost, expand, hasCommands } from '../turn/expand.js'
import type { Prompt, TypedPrompt } from '../turn/prompt.js'

import { FakeGateway, type Reply } from './fakes.js'

/** A typed prompt of `text`, with `pasted` as the text pasted into its draft. */
function typed(text: string, pasted: readonly string[] = []): TypedPrompt {
  return { images: [], kind: 'typed', pasted, text }
}

/** An expansion host over a fake gateway, with what it was told to show and restore. */
function host(replies: Record<string, Reply> = {}) {
  const gw = new FakeGateway({ replies })
  const notices: { text: string; tone: string | undefined }[] = []
  const restored: Prompt[] = []
  let changes = 0

  const h: ExpandHost = {
    changed: () => void changes++,
    gw: gw.client,
    restore: prompt => void restored.push(prompt),
    transcript: { notice: (text, tone) => void notices.push({ text, tone }) }
  }

  return { changes: () => changes, gw, h, notices, restored }
}

describe('hasCommands', () => {
  it('is true for a typed {!cmd} and false for a prompt without one', () => {
    expect(hasCommands(typed('today is {!date}'))).toBe(true)
    expect(hasCommands(typed('just words'))).toBe(false)
  })

  it('does not count a {!cmd} that was pasted', () => {
    expect(hasCommands(typed('log: {!rm -rf x}', ['log: {!rm -rf x}']))).toBe(false)
    expect(hasCommands(typed('{!date} and {!rm -rf x}', ['{!rm -rf x}']))).toBe(true)
  })

  it('is a plain check that takes a typed prompt, not a type guard', () => {
    expectTypeOf(hasCommands).parameter(0).toEqualTypeOf<TypedPrompt>()
    expectTypeOf(hasCommands).returns.toEqualTypeOf<boolean>()
  })

  it('leaves a prompt that fails the send check typed when it has no {!cmd}', () => {
    // The send path's check: past it, a typed prompt without a {!cmd} must still read as typed.
    const rest = (prompt: Prompt) => {
      if (prompt.kind === 'typed' && hasCommands(prompt)) {
        return undefined
      }

      expectTypeOf(prompt).toEqualTypeOf<Prompt>()

      return prompt.kind
    }

    expect(rest(typed('just words'))).toBe('typed')
    expect(rest({ images: [], kind: 'app', text: '{!date}' })).toBe('app')
  })
})

describe('expand', () => {
  it('gives back a prompt with nothing to run as it is, and runs no command', async () => {
    const { gw, h } = host()
    const prompts: Prompt[] = [
      typed('just words'),
      typed('log: {!date}', ['log: {!date}']),
      { images: [], kind: 'app', text: 'an app {!date}' },
      { display: '/skill', images: [], kind: 'command', text: 'a body {!date}' }
    ]

    for (const prompt of prompts) {
      expect(await expand(h, 's1', prompt)).toBe(prompt)
    }

    expect(gw.methods('shell.exec')).toEqual([])
  })

  it("runs a typed prompt's {!cmd}s in the session, and keeps its images", async () => {
    const { gw, h } = host({ 'shell.exec': p => ({ code: 0, stderr: '', stdout: `<${String(p['command'])}>\n` }) })
    const image = { mime: 'image/png', name: 'a.png', path: '/tmp/a.png' }
    const prompt: TypedPrompt = { images: [image], kind: 'typed', pasted: [], text: 'today is {!date}' }

    expect(await expand(h, 's1', prompt)).toEqual({ images: [image], text: 'today is <date>' })
    expect(gw.methods('shell.exec').map(c => c.params)).toEqual([{ command: 'date', session_id: 's1' }])
  })

  it('refuses the whole prompt when a {!cmd} cannot run: a notice, and the prompt back in the composer', async () => {
    const { changes, h, notices, restored } = host({
      'shell.exec': () => {
        throw new Error('boom')
      }
    })
    const prompt = typed('today is {!date}')

    expect(await expand(h, 's1', prompt)).toBeUndefined()
    expect(notices).toHaveLength(1)
    expect(notices[0]?.text).toMatch(/^Not sent: a \{!…\} command failed: /)
    expect(notices[0]?.tone).toBe('error')
    expect(restored).toEqual([prompt])
    expect(changes()).toBe(1)
  })
})
