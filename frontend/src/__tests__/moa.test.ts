import { describe, expect, it } from 'vitest'

import { moaLabel, moaReferenceLabel } from '../moa.js'

describe('Mixture-of-Agents', () => {
  it('labels the reference phase and the aggregator', () => {
    expect(moaLabel({ payload: { label: 'x', refs_done: 2, refs_total: 3 }, type: 'moa.progress' })).toBe('MoA: refs 2/3')
    expect(moaLabel({ payload: { phase: 'aggregator' }, type: 'moa.phase' })).toBe('Aggregating…')
    expect(moaLabel({ payload: { aggregator: 'opus' }, type: 'moa.aggregating' })).toBe('Aggregating…')
    expect(moaLabel({ payload: { phase: 'other' }, type: 'moa.phase' })).toBeUndefined()
  })

  it('names a reference by its place and model', () => {
    expect(moaReferenceLabel('gpt-5', 1, 3)).toBe('Reference 1/3 · gpt-5')
    expect(moaReferenceLabel('gpt-5', null, null)).toBe('Reference · gpt-5')
  })
})
