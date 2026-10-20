import { describe, expect, expectTypeOf, it } from 'vitest'

import { assertNever, isDefined, isNonEmpty, type NonEmpty, oneOf } from '../core/assert.js'
import { errorText } from '../core/errors.js'
import { record } from '../wire/json.js'

describe('errorText', () => {
  it('reads an Error by its message, and anything else thrown as text', () => {
    expect(errorText(new Error('no route'))).toBe('no route')
    expect(errorText(new TypeError('bad'))).toBe('bad')
    expect(errorText('plain')).toBe('plain')
    expect(errorText(42)).toBe('42')
    expect(errorText(undefined)).toBe('undefined')
    expect(errorText({ code: 1 })).toBe('[object Object]')
  })
})

describe('assertNever', () => {
  type Shape = { kind: 'dot' } | { kind: 'line'; length: number }

  const size = (s: Shape) => {
    switch (s.kind) {
      case 'dot':
        return 0
      case 'line':
        return s.length
      default:
        return assertNever(s, 'shape')
    }
  }

  it('is never reached while every variant is handled', () => {
    expect(size({ kind: 'line', length: 3 })).toBe(3)
  })

  it('throws, naming the value, when data newer than the code gets through', () => {
    const newer = { kind: 'arc' } as unknown as Shape
    expect(() => size(newer)).toThrow('Unexpected shape: {"kind":"arc"}')
    expect(() => assertNever('wat' as never)).toThrow('Unexpected variant: wat')
  })
})

describe('isDefined', () => {
  it('drops undefined and null, keeping falsy values', () => {
    const kept = [0, undefined, '', null, false, 1].filter(isDefined)
    expect(kept).toEqual([0, '', false, 1])
    expectTypeOf(kept).toEqualTypeOf<(number | string | boolean)[]>()
  })
})

describe('oneOf', () => {
  it('narrows unknown values to the listed literals', () => {
    const isLevel = oneOf(['low', 'high'])
    const value: unknown = 'high'
    expect(isLevel('low')).toBe(true)
    expect(isLevel('medium')).toBe(false)
    expect(isLevel(undefined)).toBe(false)
    expect(isLevel(1)).toBe(false)

    if (isLevel(value)) {
      expectTypeOf(value).toEqualTypeOf<'low' | 'high'>()
    }
  })
})

describe('isNonEmpty', () => {
  it('narrows a list with an item to NonEmpty', () => {
    const list: string[] = ['a']
    expect(isNonEmpty([])).toBe(false)

    if (isNonEmpty(list)) {
      expectTypeOf(list).toEqualTypeOf<NonEmpty<string>>()
      expect(list[0]).toBe('a')
    }
  })
})

describe('record', () => {
  it('reads objects and JSON text of objects, nothing else', () => {
    expect(record({ a: 1 })).toEqual({ a: 1 })
    expect(record('{"a":1}')).toEqual({ a: 1 })
    expect(record('[1]')).toBeUndefined()
    expect(record('not json')).toBeUndefined()
    expect(record([1])).toBeUndefined()
    expect(record(null)).toBeUndefined()
  })
})
