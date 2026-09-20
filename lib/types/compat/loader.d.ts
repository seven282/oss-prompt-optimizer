/**
 * Synchronous, side-effect-free loader for host (peer) packages.
 *
 * Why this exists (1.8.2): a static `import` of a host package resolves during
 * module instantiation, *before* any of the plugin's own code runs. If the
 * harness renames, moves or drops that export, Node throws
 * `SyntaxError: The requested module ... does not provide an export named ...`
 * and the failure is **not catchable** — the whole `dsh web` process refuses to
 * start. That is exactly how the 1.8.1 `deepFreeze` incident took the server
 * down. Loading the same package through `createRequire` moves the failure to a
 * `try`/`catch` we control, so a contract change degrades one feature instead of
 * blocking the host.
 *
 * `createRequire` is used rather than dynamic `import()` on purpose: it is
 * **synchronous**, so `apply()`/the service constructor stay synchronous and
 * registration order is unchanged. The host packages ship `"default"` export
 * conditions pointing at ESM files, which `require(esm)` loads on Node ≥ 22.12;
 * on an older runtime the `require` call throws, is caught, and the caller
 * degrades (it never crashes).
 *
 * @module compat/loader
 */
/**
 * Load a host package, or return `null`. Never throws, never warns.
 *
 * @param name Bare package specifier (e.g. `@deepseek-ai/dsh-tools`).
 * @returns The module namespace, or `null` when it is missing or unloadable.
 */
export declare function loadHostPackage(name: string): unknown;
/** Expected shape of a probed export. */
export type ExportKind = 'function' | 'object' | 'class';
/**
 * Read one named export of a host package, guarded by an expected kind.
 *
 * @param pkg Bare package specifier.
 * @param name Export name.
 * @param kind Expected type; a mismatch is treated as "missing".
 * @returns The export, or `null` when the package or export is unusable.
 */
export declare function resolveExport<T>(pkg: string, name: string, kind?: ExportKind): T | null;
/**
 * Read a *class* export and return a constructor that always produces
 * something — never `null`. Callers use this for "instantiate if available,
 * otherwise take the fallback branch" logic.
 */
export declare function resolveConstructor<T>(pkg: string, name: string): (new () => T) | null;
/** Test/diagnostic seam: drop the memoised loads so a probe re-runs. */
export declare function resetHostPackageCache(): void;
