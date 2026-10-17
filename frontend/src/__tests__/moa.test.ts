import { describe, expect, it } from 'vitest'

import { moaLabel, moaReferenceLabel } from '../moa.js'

describe('Mixture-of-Agents', () => {
  it('labels the reference phase and the aggregator', () => {
    expect(moaLabel('moa.progress', { label: 'x', refs_done: 2, refs_total: 3 })).toBe('MoA: refs 2/3')
    expect(moaLabel('moa.phase', { phase: 'aggregator' })).toBe('Aggregating…')
    expect(moaLabel('moa.aggregating', { aggregator: 'opus' })).toBe('Aggregating…')
    expect(moaLabel('moa.phase', { phase: 'other' })).toBeUndefined()
  })

  it('names a reference by its place and model', () => {
    expect(moaReferenceLabel('gpt-5', 1, 3)).toBe('Reference 1/3 · gpt-5')
    expect(moaReferenceLabel('gpt-5', null, null)).toBe('Reference · gpt-5')
  })
})
