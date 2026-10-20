import { describe, expect, it } from 'vitest'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { claimFigures, figures, fixPrompt } from '../figures.js'
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

  it('lets one pane ask about a reply', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tern-figures-'))

    expect(claimFigures('s1', 'reply', dir)).toBe(true)
    expect(claimFigures('s1', 'reply', dir)).toBe(false)
    expect(claimFigures('s2', 'reply', dir)).toBe(true)
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
