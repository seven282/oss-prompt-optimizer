/**
 * Local recursive deep-freeze.
 *
 * The plugin used to import `deepFreeze` from `@deepseek-ai/dsh-llm`, which only
 * re-exported it; when the harness moved the helper to `dsh-util-values` the
 * static import failed and the whole `dsh web` process refused to start (1.8.1) —
 * a five-line utility is not worth that blast radius, so it lives here.
 *
 * Semantics match the helper it replaces: own enumerable string keys are
 * traversed, children are frozen after their parent, cycles are tolerated, and
 * `AbortSignal` is skipped — freezing one would break cancellation. The traversal
 * is iterative, so a deeply nested config cannot blow the call stack.
 * @module compat/freeze
 * @see docs/compatibility.md §2, §7
 */
/**
 * Recursively freeze `value` and every plain object/array reachable from it.
 *
 * @param value Any value; primitives (and `null`) are returned untouched.
 * @returns The same reference, mutated in place — matching the helper this
 *   replaces, so call sites can keep using `deepFreeze(x)` inline.
 */
export declare function deepFreeze<T>(value: T): T;
/** Whether `value` is frozen at its top level (cheap, non-recursive check). */
export declare function isFrozen(value: unknown): boolean;
