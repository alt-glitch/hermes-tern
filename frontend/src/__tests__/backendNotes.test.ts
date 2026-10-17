import { describe, expect, it } from 'vitest'

import { FaultBudget, isDeadStream, protocolNote, slowStartNotes } from '../backendNotes.js'

describe('slowStartNotes', () => {
  it('says the backend is still starting, then up to four failure lines, capped', () => {
    const tail = [
      'INFO booting',
      'Traceback (most recent call last):',
      'DeprecationWarning: old thing',
      `ModuleNotFoundError: No module named 'x'${'y'.repeat(200)}`,
      'CRITICAL one',
      'CRITICAL two',
      'CRITICAL three'
    ].join('\n')
    const notes = slowStartNotes(tail)

    expect(notes[0]).toEqual({ text: 'The agent backend is slow to start. Still waiting…', tone: 'warning' })
    expect(notes.slice(1).map(n => n.text.slice(0, 20))).toEqual([
      'ModuleNotFoundError:',
      'CRITICAL one',
      'CRITICAL two',
      'CRITICAL three'
    ])
    expect(notes.slice(1).every(n => n.tone === 'error' && n.text.length <= 120)).toBe(true)
  })

  it('is only the warning without a tail', () => {
    expect(slowStartNotes(undefined)).toHaveLength(1)
  })
})

describe('protocolNote', () => {
  it('reports stray output once, in the info tone, with a capped preview', () => {
    const note = protocolNote('x'.repeat(500), false)

    expect(note?.tone).toBe('info')
    expect(note?.text.length).toBeLessThan(200)
    expect(protocolNote('more', true)).toBeUndefined()
  })
})

describe('faults', () => {
  it('knows a closed terminal', () => {
    expect(isDeadStream(Object.assign(new Error('write EIO'), { code: 'EIO' }))).toBe(true)
    expect(isDeadStream(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBe(true)
    expect(isDeadStream(new Error('other'))).toBe(false)
    expect(isDeadStream(null)).toBe(false)
  })

  it('allows stray faults and refuses a loop of them', () => {
    const b = new FaultBudget(3, 1000)

    expect([b.take(0), b.take(10), b.take(20)]).toEqual([true, true, true])
    expect(b.take(30)).toBe(false)
    // Old faults age out of the window.
    expect(b.take(2000)).toBe(true)
  })
})

