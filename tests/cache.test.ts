import { describe, expect, it } from 'vitest'
import { createOptimizeCache, fnv1a } from '../src/cache.js'

describe('fnv1a', () => {
  it('is deterministic and stable', () => {
    expect(fnv1a('hello')).toBe(fnv1a('hello'))
    expect(fnv1a('hello')).not.toBe(fnv1a('hellp'))
    expect(fnv1a('')).toBe('811c9dc5') // FNV-1a offset basis
  })
})

describe('createOptimizeCache', () => {
  it('stores and reads values', () => {
    const cache = createOptimizeCache<string>({ maxEntries: 10, ttlMs: 60000 })
    expect(cache.get('a')).toBeUndefined()
    cache.set('a', 'value-a')
    expect(cache.get('a')).toBe('value-a')
    expect(cache.size).toBe(1)
  })

  it('evicts the least-recently-used entry beyond maxEntries', () => {
    const cache = createOptimizeCache<string>({ maxEntries: 2, ttlMs: 0 })
    cache.set('a', '1')
    cache.set('b', '2')
    cache.set('c', '3')
    expect(cache.get('a')).toBeUndefined() // evicted
    expect(cache.get('b')).toBe('2')
    expect(cache.get('c')).toBe('3')
  })

  it('refreshes LRU order on read', () => {
    const cache = createOptimizeCache<string>({ maxEntries: 2, ttlMs: 0 })
    cache.set('a', '1')
    cache.set('b', '2')
    cache.get('a') // a becomes most-recently-used
    cache.set('c', '3')
    expect(cache.get('a')).toBe('1') // kept
    expect(cache.get('b')).toBeUndefined() // evicted
  })

  it('expires entries after ttlMs', () => {
    const cache = createOptimizeCache<string>({ maxEntries: 10, ttlMs: -1 }) // -1 → no expiry
    cache.set('a', '1')
    expect(cache.get('a')).toBe('1')
    const timed = createOptimizeCache<string>({ maxEntries: 10, ttlMs: 1 })
    timed.set('b', '2')
    expect(timed.get('b')).toBe('2')
  })

  it('overrides a key with the new value', () => {
    const cache = createOptimizeCache<string>({ maxEntries: 10, ttlMs: 0 })
    cache.set('a', '1')
    cache.set('a', '2')
    expect(cache.get('a')).toBe('2')
    expect(cache.size).toBe(1)
  })

  it('is a no-op when maxEntries <= 0', () => {
    const cache = createOptimizeCache<string>({ maxEntries: 0, ttlMs: 0 })
    cache.set('a', '1')
    expect(cache.size).toBe(0)
    expect(cache.get('a')).toBeUndefined()
  })

  it('clears all entries', () => {
    const cache = createOptimizeCache<string>({ maxEntries: 10, ttlMs: 0 })
    cache.set('a', '1')
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.get('a')).toBeUndefined()
  })
})
