import { describe, expect, it } from 'vitest'

import { CHECK_METHOD, CHECKED_EVENT, FigureAsk, type FigureGateway, figures, fixPrompt, gatewayFigureCheck } from '../figures.js'
import { replyParts } from '../replyParts.js'

describe('figures', () => {
  it('finds mermaid and svg fences, numbered per language, and skips ones inside another fence or left open', () => {
    const text = [
      'Intro',
      '```mermaid',
      'flowchart LR',
      '  A --> B',
      '```',
      '````markdown',
      '```mermaid',
      'not a figure',
      '```',
      '````',
      '~~~svg',
      '<svg viewBox="0 0 1 1"/>',
      '~~~',
      '```Mermaid',
      'sequenceDiagram',
      '```',
      '```mermaid',
      'flowchart TD'
    ].join('\n')

    expect(figures(text)).toEqual([
      { lang: 'mermaid', n: 1, source: 'flowchart LR\n  A --> B' },
      { lang: 'svg', n: 1, source: '<svg viewBox="0 0 1 1"/>' },
      { lang: 'mermaid', n: 2, source: 'sequenceDiagram' }
    ])
  })

  it('asks for the broken figures by number, with the error and line', () => {
    const prompt = fixPrompt([{ error: 'Unterminated node label', lang: 'mermaid', line: 2, n: 2, source: '' }])

    expect(prompt).toBe(
      'A figure in your last reply does not render in Tern:\n\n' +
        '- Mermaid diagram 2, line 2: Unterminated node label\n\n' +
        'Send it again, fixed, each in its fence, with no other text.'
    )
  })

})

/** A gateway whose plugin claims each reply once and answers with `results` as the session event. */
function fakeGateway(results: unknown[]) {
  const listeners: ((ev: { type: string; payload?: unknown }) => void)[] = []
  const claimed = new Set<string>()
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const gw: FigureGateway = {
    on: (_event, listener) => listeners.push(listener),
    request: (method, params) => {
      calls.push({ method, ...(params ? { params } : {}) })
      const reply = String(params?.['reply'])

      if (claimed.has(reply)) {
        return Promise.resolve({ claimed: false })
      }

      claimed.add(reply)
      setTimeout(() => listeners.forEach(l => l({ payload: { reply, results }, type: CHECKED_EVENT })))

      return Promise.resolve({ claimed: true })
    }
  }

  return { calls, gw }
}

describe('gatewayFigureCheck', () => {
  const figs = figures('```mermaid\nflowchart LR\n  A[x --> B\n```\n```svg\n<svg viewBox="0 0 1 1"/>\n```')

  it('asks the plugin and returns the figures that would not render, with the error and line', async () => {
    const { calls, gw } = fakeGateway([{ error: 'Unterminated node label', line: 2, ok: false }, { ok: true }])

    await expect(gatewayFigureCheck(gw)('s1', 'reply', figs)).resolves.toEqual([
      { error: 'Unterminated node label', lang: 'mermaid', line: 2, n: 1, source: 'flowchart LR\n  A[x --> B' }
    ])
    expect(calls[0]?.method).toBe(CHECK_METHOD)
    expect(calls[0]?.params).toMatchObject({ figures: [{ lang: 'mermaid' }, { lang: 'svg' }], session_id: 's1' })
  })

  it('lets one pane ask about a reply: a second pane gets nothing', async () => {
    const { gw } = fakeGateway([{ error: 'bad', ok: false }, { ok: true }])

    expect(await gatewayFigureCheck(gw)('s1', 'reply', figs)).toHaveLength(1)
    expect(await gatewayFigureCheck(gw)('s1', 'reply', figs)).toBeUndefined()
    expect(await gatewayFigureCheck(gw)('s2', 'reply', figs)).toHaveLength(1)
  })

  it('answers undefined when the gateway has no such method', async () => {
    const gw: FigureGateway = { on: () => undefined, request: () => Promise.reject(Object.assign(new Error('unknown'), { code: -32601 })) }

    await expect(gatewayFigureCheck(gw)('s1', 'reply', figs)).resolves.toBeUndefined()
  })
})

describe('FigureAsk', () => {
  const reply = { status: 'complete' as const, text: '```mermaid\nflowchart LR\n  A[x --> B\n```' }
  const failing = () => Promise.resolve([{ error: 'Unterminated node label', lang: 'mermaid' as const, n: 1, source: '' }])
  const settle = () => new Promise(r => setTimeout(r))

  it('asks once per user prompt, and again after the next one', async () => {
    const sent: string[] = []
    const ask = new FigureAsk(failing, () => 's1', p => sent.push(p))

    ask.afterReply(reply)
    await settle()
    ask.afterReply(reply)
    await settle()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('Mermaid diagram 1: Unterminated node label')

    ask.reset()
    ask.afterReply(reply)
    await settle()
    expect(sent).toHaveLength(2)
  })

  it('stays quiet for a reply without figures, an interrupted one, or when the pane moved to another session', async () => {
    const sent: string[] = []
    let live = 's1'
    const ask = new FigureAsk(failing, () => live, p => sent.push(p))

    ask.afterReply({ status: 'complete', text: 'plain' })
    ask.afterReply({ ...reply, status: 'interrupted' })
    ask.afterReply(reply)
    live = 's2'
    await settle()
    expect(sent).toEqual([])
  })
})

describe('replyParts', () => {
  it('shows MEDIA lines and local Markdown images as media, outside fences only', () => {
    const text = [
      'Here it is:',
      'MEDIA:/tmp/plot.png',
      '![chart](./out/chart.svg)',
      '![remote](https://example.com/a.png)',
      '```',
      'MEDIA:/tmp/in-code.png',
      '```',
      'Done.'
    ].join('\n')

    expect(replyParts(text)).toEqual([
      { kind: 'md', text: 'Here it is:' },
      { kind: 'media', path: '/tmp/plot.png' },
      { kind: 'media', path: './out/chart.svg' },
      { kind: 'md', text: '![remote](https://example.com/a.png)\n```\nMEDIA:/tmp/in-code.png\n```\nDone.' }
    ])
  })

  it('keeps a streamed last line as Markdown until it ends', () => {
    expect(replyParts('See:\nMEDIA:/tmp/a.p', true)).toEqual([{ kind: 'md', text: 'See:\nMEDIA:/tmp/a.p' }])
    expect(replyParts('See:\nMEDIA:/tmp/a.png\n', true)).toEqual([
      { kind: 'md', text: 'See:' },
      { kind: 'media', path: '/tmp/a.png' }
    ])
  })

  it('leaves text without media alone', () => {
    expect(replyParts('plain $x$ and `code`')).toEqual([{ kind: 'md', text: 'plain $x$ and `code`' }])
  })
})
