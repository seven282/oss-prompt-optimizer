/**
 * Deterministic key hashing + an in-memory LRU/TTL cache for optimization
 * results. Pure functions — no harness dependency, unit-testable standalone.
 *
 * The cache is a token-saving layer (see ADR-008): a repeat of the same
 * "what is fed to the model" (route + system + truncated instruction +
 * truncated context) returns the previous validated result with zero model
 * calls. In-memory only — never persisted, cleared on plugin reload.
 */

/** FNV-1a 32-bit hash → 8-hex string. Deterministic, dependency-free (non-security). */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** One stored entry. */
interface OptimizeCacheEntry<T> {
  value: T
  expiresAt: number
}

/** Cache bounds. `maxEntries <= 0` disables storage; `ttlMs <= 0` disables expiry. */
export interface OptimizeCacheOptions {
  maxEntries: number
  ttlMs: number
}

/** Generic LRU + TTL cache surface. */
export interface OptimizeCache<T> {
  /** Current entry count (for tests/observability). */
  readonly size: number
  /** Read a live entry (LRU refresh on hit); `undefined` on miss/expiry. */
  get(key: string): T | undefined
  /** Store an entry, evicting the least-recently-used one beyond `maxEntries`. */
  set(key: string, value: T): void
  /** Drop all entries. */
  clear(): void
}

/**
 * LRU + TTL cache. `Map` iteration order is insertion order, so re-inserting
 * on read/get keeps it as an LRU list; `set` re-inserts then evicts the
 * first (oldest) entry while over capacity. Pure and synchronous.
 */
export function createOptimizeCache<T>(options: OptimizeCacheOptions): OptimizeCache<T> {
  const { maxEntries, ttlMs } = options
  const map = new Map<string, OptimizeCacheEntry<T>>()
  return {
    get size() {
      return map.size
    },
    get(key) {
      if (maxEntries <= 0) return undefined
      const entry = map.get(key)
      if (entry === undefined) return undefined
      if (ttlMs > 0 && Date.now() > entry.expiresAt) {
        map.delete(key)
        return undefined
      }
      // LRU refresh: re-insert to the tail.
      map.delete(key)
      map.set(key, entry)
      return entry.value
    },
    set(key, value) {
      if (maxEntries <= 0) return
      const entry = { value, expiresAt: ttlMs > 0 ? Date.now() + ttlMs : Number.POSITIVE_INFINITY }
      map.delete(key)
      map.set(key, entry)
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value
        if (oldest === undefined) break
        map.delete(oldest)
      }
    },
    clear() {
      map.clear()
    },
  }
}
