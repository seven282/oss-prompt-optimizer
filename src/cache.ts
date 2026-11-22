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

/**
 * Jaccard similarity over character bigrams (0..1). Works well for both CJK
 * and Latin text; used by the near-miss warm start (阶段 1A): when an exact
 * cache hit is impossible, a similar cached instruction can seed the
 * re-optimization instead of starting from scratch.
 */
export function bigramJaccard(a: string, b: string): number {
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  const x = norm(a)
  const y = norm(b)
  if (x.length === 0 && y.length === 0) return 1
  if (x.length === 0 || y.length === 0) return 0
  const grams = (s: string) => {
    const set = new Set<string>()
    if (s.length === 1) {
      set.add(s)
      return set
    }
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const gx = grams(x)
  const gy = grams(y)
  let overlap = 0
  for (const g of gx) if (gy.has(g)) overlap++
  const union = gx.size + gy.size - overlap
  return union === 0 ? 0 : overlap / union
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
  /** Snapshot of all live entries (for near-miss warm-start scanning). */
  entries(): [string, T][]
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
    entries() {
      const out: [string, T][] = []
      for (const [key, entry] of map) {
        if (ttlMs > 0 && Date.now() > entry.expiresAt) {
          map.delete(key)
          continue
        }
        out.push([key, entry.value])
      }
      return out
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

/**
 * P5 — semantic similarity layer (2026-11-22), deliberately opt-in.
 *
 * This plugin has no embedding capability of its own (compat probes only
 * defineTool/createUserMessage/BlockAssembler), and the product promises zero
 * extra model calls on the hot path. So instead of baking in an embedder we
 * expose a *scorer interface*: a host/deployment that already has embeddings
 * may inject one, and only then does a second similarity layer run — on top
 * of `bigramJaccard`, which always remains the first, dependency-free layer.
 *
 * Default off: with no scorer, or below the 0.95 threshold, behaviour is
 * identical to the bigram-only path. Multi-turn context is isolated: a cache
 * hit is refused whenever the two entries carry different context scopes,
 * because semantically-similar prompts in different turns can demand
 * different answers (the failure AWS/Redis both call out).
 */

/** A host-supplied similarity function, 0..1. Never called unless injected. */
export type SemanticScorer = (a: string, b: string) => number

/** Default threshold — high on purpose; lower only after measuring false hits. */
export const SEMANTIC_DEFAULT_THRESHOLD = 0.95

/**
 * Decide whether two cached requests are semantically equivalent.
 * Returns `false` unless a scorer was injected, both scopes match, and the
 * score clears the threshold. `undefined` scope on both sides counts as the
 * same (global) namespace.
 */
export function semanticMatch(
  aText: string,
  bText: string,
  scorer: SemanticScorer | undefined,
  options: {
    threshold?: number
    aScope?: string
    bScope?: string
  } = {},
): boolean {
  if (scorer === undefined) return false
  const aScope = options.aScope ?? ''
  const bScope = options.bScope ?? ''
  if (aScope !== bScope) return false
  const threshold = options.threshold ?? SEMANTIC_DEFAULT_THRESHOLD
  const score = scorer(aText, bText)
  return Number.isFinite(score) && score >= threshold
}
