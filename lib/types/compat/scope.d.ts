/**
 * Per-feature dependency scoping.
 *
 * A static `inject = [...every service...]` makes cordis refuse to load the
 * plugin at all unless *every* one is mounted, so a single renamed service took
 * the whole plugin offline (1.8.2). cordis 4's `ctx.inject(deps, callback)` gates
 * one registration on one dependency, so each feature now fails alone.
 * Without `inject` (hosts, unit tests) the callback runs immediately — identical
 * to the behaviour before this module existed, so existing mocks stay valid.
 *
 * @module compat/scope
 * @see docs/compatibility.md §2, §7
 */
import type { Context } from '@deepseek-ai/cordis';
/**
 * Run `callback` once every name in `deps` is available on `ctx`.
 *
 * Falls back to an immediate call when the context offers no `inject` (plain
 * object contexts / older cordis), and logs rather than rethrows when the
 * scoped registration itself fails, so a broken feature can never become a
 * broken plugin.
 *
 * @param ctx Context that may or may not implement `inject`.
 * @param deps Service names the callback depends on.
 * @param callback Registration to perform, receiving the scoped context.
 */
export declare function scopedInject<T extends Context>(ctx: T, deps: readonly string[], callback: (scoped: T) => void): void;
