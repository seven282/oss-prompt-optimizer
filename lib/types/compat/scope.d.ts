/**
 * Per-feature dependency scoping.
 *
 * Why this exists (1.8.2): declaring `static inject = ['llm','tools',
 * 'systemPrompt','commands','settings']` makes cordis refuse to load the plugin
 * at all unless *every* service is mounted. One renamed service therefore took
 * the entire plugin offline. cordis 4 exposes `ctx.inject(deps, callback)`,
 * which gates a single registration on a single dependency, so each feature now
 * fails alone.
 *
 * On hosts (and in unit tests) whose context has no `inject`, the callback runs
 * immediately — behaviour identical to before this module existed. That keeps
 * the mock contexts used across the test suite valid without change.
 *
 * @module compat/scope
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
