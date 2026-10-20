import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clip, plural } from '../core/text.js'
import { ageShort, clockSeconds, clockShort, duration, durationCompact, durationWhole, flat, homeTilde, nonEmpty, relative, relativePath } from '../view/format.js'

const timeString = Date.prototype.toLocaleTimeString

/** Times as en-US in UTC, whatever this machine's locale and zone. */
beforeEach(() => {
  vi.spyOn(Date.prototype, 'toLocaleTimeString').mockImplementation(function (this: Date, locales, options) {
    const named = locales === undefined || (Array.isArray(locales) && locales.length === 0) ? 'en-US' : locales

    return timeString.call(this, named, { timeZone: 'UTC', ...options })
  })
})

afterEach(() => vi.restoreAllMocks())

describe('format', () => {
  it('reads a string with something in it, and nothing else', () => {
    expect(nonEmpty('a')).toBe('a')
    expect(nonEmpty(' ')).toBe(' ')
    expect([nonEmpty(''), nonEmpty(3), nonEmpty(undefined), nonEmpty(null)]).toEqual([undefined, undefined, undefined, undefined])
  })

  it('clips inside the limit with …, or keeps the limit and puts … on its own line', () => {
    expect(clip('abcdef', { max: 4 })).toBe('abc…')
    expect(clip('abcdef', { mark: 'end', max: 4 })).toBe('abc…')
    expect(clip('abcdef', { mark: 'line', max: 4 })).toBe('abcd\n…')
    expect(clip('abcd', { max: 4 })).toBe('abcd')
    expect(clip('abcd', { mark: 'line', max: 4 })).toBe('abcd')
  })

  it('puts a text on one line', () => {
    expect(flat('  cat a\n  | head\t-n 2 ')).toBe('cat a | head -n 2')
  })

  it('counts a noun', () => {
    expect([plural(0, 'file'), plural(1, 'file'), plural(2, 'file')]).toEqual(['0 files', '1 file', '2 files'])
    expect([plural(1, 'match', 'matches'), plural(3, 'match', 'matches')]).toEqual(['1 match', '3 matches'])
  })

  it('writes a duration three ways', () => {
    expect([400, 4_300, 42_000, 185_000, 3_725_000].map(duration)).toEqual(['400ms', '4.3s', '42s', '3m 05s', '1h 02m'])
    expect([820, 4_300, 42_000, 62_000, 3_725_000, -1].map(durationCompact)).toEqual(['820ms', '4.3s', '42s', '1m 2s', '1h 2m 5s', '0ms'])
    expect([400, 42_000, 185_000, 3_725_000].map(durationWhole)).toEqual(['0s', '42s', '3m 5s', '1h 2m'])
  })

  it('says how long ago, and how far a time is, in the largest whole unit', () => {
    const NOW = Date.parse('2026-10-17T12:00:00Z')
    const at = (ms: number) => new Date(NOW + ms).toISOString()

    expect([ageShort(20_000), ageShort(25 * 60_000), ageShort(2 * 3_600_000), ageShort(3 * 86_400_000)]).toEqual(['1m', '25m', '2h', '3d'])
    expect([ageShort(14 * 86_400_000), ageShort(60 * 86_400_000), ageShort(400 * 86_400_000)]).toEqual(['2w', '2mo', '1y'])
    expect(relative(at(10_000), NOW)).toBe('now')
    expect(relative(at(29 * 60_000), NOW)).toBe('in 29m')
    expect(relative(at(-3 * 3_600_000), NOW)).toBe('3h ago')
    expect(relative(at(2 * 86_400_000), NOW)).toBe('in 2d')
    expect(relative(at(-14 * 86_400_000), NOW)).toBe('2w ago')
    expect(relative(null, NOW)).toBe('')
  })

  it('writes a clock time to the minute or to the second', () => {
    const at = Date.UTC(2026, 9, 20, 18, 15, 7)

    expect(clockShort(at)).toBe('6:15 pm')
    expect(clockSeconds(Date.UTC(2026, 9, 20, 14, 2, 7))).toBe('14:02:07')
  })

  it('puts ~ for home, and makes a path relative to the working folder', () => {
    expect(homeTilde('/home/u/code/x', '/home/u')).toBe('~/code/x')
    expect(homeTilde('/opt/x', '/home/u')).toBe('/opt/x')
    expect(homeTilde('/home/u/x', undefined)).toBe('/home/u/x')

    const where = { cwd: '/home/u/code/', home: '/home/u' }

    expect(relativePath('/home/u/code/src/a.ts', where)).toBe('src/a.ts')
    expect(relativePath('/home/u/notes.md', where)).toBe('~/notes.md')
    expect(relativePath('./b.ts', where)).toBe('b.ts')
    expect(relativePath('/etc/hosts', where)).toBe('/etc/hosts')
  })
})
