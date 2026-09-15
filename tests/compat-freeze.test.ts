import { describe, expect, it } from 'vitest'
import { deepFreeze, isFrozen } from '../src/compat/freeze.js'

describe('deepFreeze', () => {
  it('freezes nested objects and arrays', () => {
    const value = deepFreeze({ a: { b: [1, { c: 2 }] }, list: [{ d: 3 }] })
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.a)).toBe(true)
    expect(Object.isFrozen(value.a.b)).toBe(true)
    expect(Object.isFrozen(value.a.b[1])).toBe(true)
    expect(Object.isFrozen(value.list)).toBe(true)
    expect(Object.isFrozen(value.list[0])).toBe(true)
  })

  it('returns the same reference, so it stays usable inline', () => {
    const value = { a: 1 }
    expect(deepFreeze(value)).toBe(value)
  })

  it('returns primitives and null untouched', () => {
    expect(deepFreeze(42)).toBe(42)
    expect(deepFreeze('text')).toBe('text')
    expect(deepFreeze(null)).toBeNull()
    expect(deepFreeze(undefined)).toBeUndefined()
    expect(isFrozen(42)).toBe(false)
  })

  it('is idempotent on an already frozen object', () => {
    const once = deepFreeze({ a: { b: 1 } })
    const twice = deepFreeze(once)
    expect(twice).toBe(once)
    expect(Object.isFrozen(twice.a)).toBe(true)
  })

  it('tolerates cycles without recursing forever', () => {
    const value: { name: string; self?: unknown } = { name: 'root' }
    value.self = value
    expect(() => deepFreeze(value)).not.toThrow()
    expect(Object.isFrozen(value)).toBe(true)
  })

  it('leaves AbortSignal instances mutable', () => {
    // An AbortSignal carries live internal state; freezing it breaks
    // cancellation, and the optimizer passes one inside the options object it
    // freezes. This mirrors the harness helper's documented exclusion.
    const controller = new AbortController()
    const value = deepFreeze({ signal: controller.signal, plain: { nested: true } })
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(controller.signal)).toBe(false)
    expect(() => controller.abort()).not.toThrow()
    expect(controller.signal.aborted).toBe(true)
    // Non-signal children are still frozen.
    expect(Object.isFrozen(value.plain)).toBe(true)
  })

  it('actually prevents mutation', () => {
    const value = deepFreeze({ a: { b: 1 } })
    expect(() => {
      'use strict'
      value.a.b = 2
    }).toThrow()
  })
})
