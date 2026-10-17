import { describe, expect, it } from 'vitest'

import { hardBreaks, isPreformatted } from '../preformatted.js'
import { compactCount, parseCount, parseUsage } from '../usage.js'

const FIXTURE = `⏱️ **Rate Limits:** RPM: 794/800 | RPH: 33.6K/33.6K (resets 37m 26s) | TPM: 8.0M/8.0M | TPH: 336.0M/336.0M (resets 37m 21s)

📊 **Session Token Usage**
Model: \`anthropic/claude-opus-5.5\`
Input tokens: 2,947
Output tokens: 3,604
Total: 1,308,436
API calls: 10
Context: 132,196 / 800,000 (17%)

🧩 **Context breakdown** _(estimated)_
• System prompt: ~10,245 (~13%)
• Tool definitions: ~19,161 (~24%)
• Rules: ~3,342 (~4%)
• Subagent definitions: ~1,194 (~1%)
• Memory: ~1,068 (~1%)
• Conversation: ~45,874 (~57%)

📈 **Nous credits**
Provider: nous
Subscription credits: $0.00
Top-up credits: $54,366.76
Total usable: $54,366.76
Top up: https://portal.nousresearch.com/orgs/nousresearch-155/billing?topup=open
(or run /topup)`

describe('parseCount', () => {
  it('reads separators, tildes and K/M/B suffixes', () => {
    expect(parseCount('2,947')).toBe(2947)
    expect(parseCount('33.6K')).toBe(33600)
    expect(parseCount('~8.0M')).toBe(8_000_000)
    expect(parseCount('1.5b')).toBe(1.5e9)
    expect(parseCount('n/a')).toBeNaN()
  })

  it('compacts for meter labels', () => {
    expect(compactCount(132196)).toBe('132K')
    expect(compactCount(800000)).toBe('800K')
    expect(compactCount(8_000_000)).toBe('8M')
    expect(compactCount(794)).toBe('794')
  })
})

describe('parseUsage', () => {
  it('parses every section of a full answer', () => {
    const sections = parseUsage(FIXTURE)!

    expect(sections.map(s => s.kind)).toEqual(['limits', 'session', 'breakdown', 'credits'])

    const [limits, session, breakdown, credits] = sections

    expect(limits).toMatchObject({
      items: [
        { limit: 800, left: 794, name: 'RPM', reset: undefined },
        { limit: 33600, left: 33600, name: 'RPH', reset: '37m 26s' },
        { limit: 8e6, left: 8e6, name: 'TPM' },
        { limit: 336e6, left: 336e6, name: 'TPH', reset: '37m 21s' }
      ]
    })
    expect(session).toMatchObject({ context: { max: 800000, used: 132196 } })
    expect((session as { rows: unknown[] }).rows).toEqual([
      { key: 'Model', value: 'anthropic/claude-opus-5.5' },
      { key: 'Input tokens', value: '2,947' },
      { key: 'Output tokens', value: '3,604' },
      { key: 'Total', value: '1,308,436' },
      { key: 'API calls', value: '10' }
    ])
    expect(breakdown).toMatchObject({ note: 'estimated' })
    expect((breakdown as { items: unknown[] }).items).toHaveLength(6)
    expect((breakdown as { items: { label: string; tokens: number; pct: number }[] }).items[1]).toEqual({
      label: 'Tool definitions',
      pct: 24,
      tokens: 19161
    })
    expect((credits as { rows: { key: string; value: string }[] }).rows.at(-1)).toEqual({
      key: 'Top up',
      value: 'https://portal.nousresearch.com/orgs/nousresearch-155/billing?topup=open'
    })
    expect(credits).toMatchObject({ notes: ['(or run /topup)'] })
  })

  it('tolerates missing and reordered sections', () => {
    const partial = `📈 **Nous credits**\nTotal usable: $1.00\n\n📊 **Session Token Usage**\nInput tokens: 5\n`
    const sections = parseUsage(partial)!

    expect(sections.map(s => s.kind)).toEqual(['credits', 'session'])
    expect(sections[1]).toMatchObject({ rows: [{ key: 'Input tokens', value: '5' }] })
  })

  it('keeps unknown sections and a preamble as text', () => {
    const sections = parseUsage('Hello\n\n**Rate Limits:** RPM: 1/10\n\n**Mystery**\nsome words')!

    expect(sections.map(s => s.kind)).toEqual(['text', 'limits', 'text'])
    expect(sections[2]).toMatchObject({ text: 'some words', title: 'Mystery' })
  })

  it('returns null when nothing is recognised', () => {
    expect(parseUsage('No usage yet.')).toBeNull()
    expect(parseUsage('**Rate Limits:** nothing parseable')).toBeNull()
  })
})

describe('isPreformatted', () => {
  it('flags box drawing, ASCII rules, colour codes and aligned columns', () => {
    expect(isPreformatted('┌──┐\n│a │\n└──┘')).toBe(true)
    expect(isPreformatted('+-----+-----+\n| a   | b   |\n+-----+-----+')).toBe(true)
    expect(isPreformatted('\u001b[31mred\u001b[0m')).toBe(true)
    expect(isPreformatted('name      description\nread      Read a file\nwrite     Write a file')).toBe(true)
  })

  it('leaves Markdown and prose alone', () => {
    expect(isPreformatted(FIXTURE)).toBe(false)
    expect(isPreformatted('**Tools**\n• read — reads files\n• write — writes files')).toBe(false)
    expect(isPreformatted('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(false)
    expect(isPreformatted('One line.  Two spaces after a period.')).toBe(false)
  })
})

describe('hardBreaks', () => {
  it('keeps one fact per line but leaves blank lines and code fences alone', () => {
    expect(hardBreaks('Path: a\nModel: b\n\nNext')).toBe('Path: a  \nModel: b\n\nNext')
    expect(hardBreaks('x\n```\na\nb\n```\ny')).toBe('x  \n```\na\nb\n```\ny')
  })
})
