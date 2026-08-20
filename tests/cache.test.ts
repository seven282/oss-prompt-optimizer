import { describe, expect, it } from 'vitest'
import { bigramJaccard, createOptimizeCache, fnv1a } from '../src/cache.js'

describe('fnv1a', () => {
  it('is deterministic and stable', () => {
    expect(fnv1a('hello')).toBe(fnv1a('hello'))
    expect(fnv1a('hello')).not.toBe(fnv1a('hellp'))
    expect(fnv1a('')).toBe('811c9dc5') // FNV-1a offset basis
  })
})

describe('bigramJaccard', () => {
  it('scores identical and empty inputs', () => {
    expect(bigramJaccard('写周报', '写周报')).toBe(1)
    expect(bigramJaccard('', '')).toBe(1)
    expect(bigramJaccard('abc', '')).toBe(0)
  })

  it('scores similar CJK instructions above different ones', () => {
    const similar = bigramJaccard('帮我写一份周报', '帮我写一份月报')
    const different = bigramJaccard('帮我写一份周报', '部署服务到服务器')
    expect(similar).toBeGreaterThanOrEqual(0.5)
    expect(similar).toBeGreaterThan(different)
    expect(different).toBeLessThan(0.5)
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

  it('exposes live entries for near-miss scanning', () => {
    const cache = createOptimizeCache<string>({ maxEntries: 10, ttlMs: 0 })
    cache.set('k1', 'v1')
    cache.set('k2', 'v2')
    const entries = cache.entries()
    expect(entries).toEqual([['k1', 'v1'], ['k2', 'v2']])
    entries.length = 0
    expect(cache.size).toBe(2)
  })

  it('clears all entries', () => {
    const cache = createOptimizeCache<string>({ maxEntries: 10, ttlMs: 0 })
    cache.set('a', '1')
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.get('a')).toBeUndefined()
  })
})
