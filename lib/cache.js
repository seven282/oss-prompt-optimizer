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
export function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}
/**
 * Jaccard similarity over character bigrams (0..1). Works well for both CJK
 * and Latin text; used by the near-miss warm start (阶段 1A): when an exact
 * cache hit is impossible, a similar cached instruction can seed the
 * re-optimization instead of starting from scratch.
 */
export function bigramJaccard(a, b) {
    const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
    const x = norm(a);
    const y = norm(b);
    if (x.length === 0 && y.length === 0)
        return 1;
    if (x.length === 0 || y.length === 0)
        return 0;
    const grams = (s) => {
        const set = new Set();
        if (s.length === 1) {
            set.add(s);
            return set;
        }
        for (let i = 0; i < s.length - 1; i++)
            set.add(s.slice(i, i + 2));
        return set;
    };
    const gx = grams(x);
    const gy = grams(y);
    let overlap = 0;
    for (const g of gx)
        if (gy.has(g))
            overlap++;
    const union = gx.size + gy.size - overlap;
    return union === 0 ? 0 : overlap / union;
}
/**
 * LRU + TTL cache. `Map` iteration order is insertion order, so re-inserting
 * on read/get keeps it as an LRU list; `set` re-inserts then evicts the
 * first (oldest) entry while over capacity. Pure and synchronous.
 */
export function createOptimizeCache(options) {
    const { maxEntries, ttlMs } = options;
    const map = new Map();
    return {
        get size() {
            return map.size;
        },
        get(key) {
            if (maxEntries <= 0)
                return undefined;
            const entry = map.get(key);
            if (entry === undefined)
                return undefined;
            if (ttlMs > 0 && Date.now() > entry.expiresAt) {
                map.delete(key);
                return undefined;
            }
            // LRU refresh: re-insert to the tail.
            map.delete(key);
            map.set(key, entry);
            return entry.value;
        },
        entries() {
            const out = [];
            for (const [key, entry] of map) {
                if (ttlMs > 0 && Date.now() > entry.expiresAt) {
                    map.delete(key);
                    continue;
                }
                out.push([key, entry.value]);
            }
            return out;
        },
        set(key, value) {
            if (maxEntries <= 0)
                return;
            const entry = { value, expiresAt: ttlMs > 0 ? Date.now() + ttlMs : Number.POSITIVE_INFINITY };
            map.delete(key);
            map.set(key, entry);
            while (map.size > maxEntries) {
                const oldest = map.keys().next().value;
                if (oldest === undefined)
                    break;
                map.delete(oldest);
            }
        },
        clear() {
            map.clear();
        },
    };
}
