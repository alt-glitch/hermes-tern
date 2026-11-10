import { describe, expect, it } from 'vitest'

import { displayMarkdown, fileHref, rewriteLocalMarkdownLinks, ternSharesFrontendHost } from '../artifacts/links.js'
import { entryId } from '../core/ids.js'
import type { TurnEntry } from '../model.js'
import { entryNode, type TranscriptContext } from '../view/transcript.js'

import { tree } from './fakes.js'

const cwd = '/home/agent/work'

describe('Hermes session file links', () => {
  it('resolves relative and absolute paths without falling back to the frontend cwd', () => {
    expect(fileHref('docs/report.md', cwd)).toBe('file:///home/agent/work/docs/report.md')
    expect(fileHref('/tmp/a b.svg', '')).toBe('file:///tmp/a%20b.svg')
    expect(fileHref('docs/report.md', '')).toBeUndefined()
    expect(fileHref('../readme.md', cwd, { line: 10, endLine: 20 })).toBe('file:///home/agent/readme.md#L10-L20')
    expect(fileHref('x.ts', cwd, { line: 12, col: 3 })).toBe('file:///home/agent/work/x.ts#L12C3')
    expect(fileHref('x.ts', cwd, { line: -2 })).toBe('file:///home/agent/work/x.ts')
  })

  it('rejects other schemes, UNC paths, malformed and control-byte targets', () => {
    for (const path of ['https://example.com/a', 'javascript:alert(1)', 'file:///tmp/a', '//server/a', '', '  ', 'a\nb']) {
      expect(fileHref(path, cwd)).toBeUndefined()
    }

    expect(fileHref('a.md', 'relative')).toBeUndefined()
  })

  it('rewrites only prose inline Markdown targets and decodes percent escapes once', () => {
    const input = [
      'See [the plan](docs/my%20plan.md#L4-L7), [web](https://example.org), and ![img](a.png).',
      'The target in ' + String.fromCharCode(96) + '[code](x.md)' + String.fromCharCode(96) + ' stays.',
      '    [indented](in-code.md)',
      '~~~md',
      '[fenced](in-code.md)',
      '~~~'
    ].join('\n')
    const result = rewriteLocalMarkdownLinks(input, cwd)

    expect(result).toContain('[the plan](file:///home/agent/work/docs/my%20plan.md#L4-L7)')
    expect(result).toContain('[web](https://example.org)')
    expect(result).toContain('![img](a.png)')
    expect(result).toContain('    [indented](in-code.md)')
    expect(result).toContain('[fenced](in-code.md)')
    expect(result).toContain('[code](x.md)')
    expect(rewriteLocalMarkdownLinks(input, '')).toBe(input)
  })

  it('does not retarget unsafe invisible characters into a different file', () => {
    const bad = '[item](docs/a' + String.fromCharCode(0x1b) + 'b.md)'
    const shown = displayMarkdown(bad, cwd)

    expect(shown).not.toContain('file:///')
    expect(shown).not.toContain(String.fromCharCode(0x1b))
    expect(shown).toContain('docs/a')
  })
})

describe('artifact links survive cached transcript revisions', () => {
  const turn: TurnEntry = {
    blocks: [{ id: entryId('x'), kind: 'text', text: 'See [spec](spec.md)' }],
    end: { endedAt: 11, status: 'done' },
    id: entryId('t'),
    kind: 'turn',
    rev: 0,
    startedAt: 10
  }
  const cx: TranscriptContext = {
    copy: () => undefined,
    links: { cwd, hostLocal: true, media: false },
    now: 12,
    welcome: { version: '' }
  }

  it('uses the session folder, and invalidates a cached node when the host changes', () => {
    const local = JSON.stringify(tree(entryNode(turn, 'main.t', cx)))
    expect(local).toContain('file:///home/agent/work/spec.md')
    const remote = JSON.stringify(tree(entryNode(turn, 'main.t', {
      ...cx, links: { cwd, hostLocal: false, media: false }
    })))
    expect(remote).toContain('[spec](spec.md)')
    expect(remote).not.toContain('file:///')
  })
})


describe('Tern and the frontend host boundary', () => {
  it('treats SSH streams as remote even with a local Hermes gateway', () => {
    expect(ternSharesFrontendHost({})).toBe(true)
    for (const name of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) {
      expect(ternSharesFrontendHost({ [name]: 'ssh' })).toBe(false)
    }
  })
})
