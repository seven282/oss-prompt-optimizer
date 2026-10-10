/**
 * Synchronous, side-effect-free loader for host (peer) packages.
 *
 * A static `import` of a host package resolves during instantiation, before any
 * plugin code runs; if the harness renames or drops that export Node throws, and
 * the failure is **not catchable** — the whole `dsh web` process refuses to start
 * (1.8.1). `createRequire` moves it into a `try`/`catch` we control.
 *
 * It is `createRequire` rather than dynamic `import()` on purpose: synchronous,
 * so `apply()` stays synchronous and registration order is unchanged. Host ESM
 * under a `"default"` condition loads on Node ≥ 22.12; older runtimes degrade.
 *
 * @module compat/loader
 * @see docs/compatibility.md §2, §7
 */
import { createRequire } from 'node:module';
/**
 * Resolver anchored at this module, so lookups walk up the same
 * `node_modules` chain a static import from the plugin would.
 */
const resolveFromPlugin = createRequire(import.meta.url);
/** package name → loaded module namespace, or `null` when it could not load. */
const moduleCache = new Map();
/**
 * Load a host package, or return `null`. Never throws, never warns.
 *
 * @param name Bare package specifier (e.g. `@deepseek-ai/dsh-tools`).
 * @returns The module namespace, or `null` when it is missing or unloadable.
 */
export function loadHostPackage(name) {
    if (moduleCache.has(name))
        return moduleCache.get(name) ?? null;
    let loaded = null;
    try {
        loaded = resolveFromPlugin(name);
    }
    catch {
        loaded = null;
    }
    moduleCache.set(name, loaded);
    return loaded;
}
/** Whether `value` matches the requested kind. */
function matchesKind(value, kind) {
    if (kind === 'function')
        return typeof value === 'function';
    if (kind === 'class')
        return typeof value === 'function';
    return value !== null && typeof value === 'object';
}
/**
 * Read one named export of a host package, guarded by an expected kind.
 *
 * @param pkg Bare package specifier.
 * @param name Export name.
 * @param kind Expected type; a mismatch is treated as "missing".
 * @returns The export, or `null` when the package or export is unusable.
 */
export function resolveExport(pkg, name, kind = 'function') {
    const mod = loadHostPackage(pkg);
    if (mod === null || typeof mod !== 'object')
        return null;
    const value = mod[name];
    return matchesKind(value, kind) ? value : null;
}
/**
 * Read a *class* export and return a constructor that always produces
 * something — never `null`. Callers use this for "instantiate if available,
 * otherwise take the fallback branch" logic.
 */
export function resolveConstructor(pkg, name) {
    return resolveExport(pkg, name, 'class');
}
/** Test/diagnostic seam: drop the memoised loads so a probe re-runs. */
export function resetHostPackageCache() {
    moduleCache.clear();
}
