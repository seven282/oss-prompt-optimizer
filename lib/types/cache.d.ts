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
export declare function fnv1a(text: string): string;
/**
 * Jaccard similarity over character bigrams (0..1). Works well for both CJK
 * and Latin text; used by the near-miss warm start (阶段 1A): when an exact
 * cache hit is impossible, a similar cached instruction can seed the
 * re-optimization instead of starting from scratch.
 */
export declare function bigramJaccard(a: string, b: string): number;
/** Cache bounds. `maxEntries <= 0` disables storage; `ttlMs <= 0` disables expiry. */
export interface OptimizeCacheOptions {
    maxEntries: number;
    ttlMs: number;
}
/** Generic LRU + TTL cache surface. */
export interface OptimizeCache<T> {
    /** Current entry count (for tests/observability). */
    readonly size: number;
    /** Read a live entry (LRU refresh on hit); `undefined` on miss/expiry. */
    get(key: string): T | undefined;
    /** Snapshot of all live entries (for near-miss warm-start scanning). */
    entries(): [string, T][];
    /** Store an entry, evicting the least-recently-used one beyond `maxEntries`. */
    set(key: string, value: T): void;
    /** Drop all entries. */
    clear(): void;
}
/**
 * LRU + TTL cache. `Map` iteration order is insertion order, so re-inserting
 * on read/get keeps it as an LRU list; `set` re-inserts then evicts the
 * first (oldest) entry while over capacity. Pure and synchronous.
 */
export declare function createOptimizeCache<T>(options: OptimizeCacheOptions): OptimizeCache<T>;
