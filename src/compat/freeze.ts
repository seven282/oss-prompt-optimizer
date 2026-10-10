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

/** Pending unit of work: visit a node, or schedule one of its properties. */
type FreezeTask =
  | { readonly kind: 'visit'; readonly node: unknown }
  | { readonly kind: 'property'; readonly source: Record<string, unknown>; readonly key: string }

/**
 * Recursively freeze `value` and every plain object/array reachable from it.
 *
 * @param value Any value; primitives (and `null`) are returned untouched.
 * @returns The same reference, mutated in place — matching the helper this
 *   replaces, so call sites can keep using `deepFreeze(x)` inline.
 */
export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>()
  const pending: FreezeTask[] = [{ kind: 'visit', node: value }]
  while (pending.length > 0) {
    const task = pending.pop()
    if (task === undefined) continue
    if (task.kind === 'property') {
      pending.push({ kind: 'visit', node: task.source[task.key] })
      continue
    }
    const node = task.node
    if (node === null || typeof node !== 'object') continue
    // Live-state objects must stay mutable (see the module docstring).
    if (node instanceof AbortSignal) continue
    if (seen.has(node)) continue
    seen.add(node)
    Object.freeze(node)
    const source = node as Record<string, unknown>
    for (const key of Object.keys(source)) {
      pending.push({ kind: 'property', source, key })
    }
  }
  return value
}

/** Whether `value` is frozen at its top level (cheap, non-recursive check). */
export function isFrozen(value: unknown): boolean {
  return value !== null && typeof value === 'object' && Object.isFrozen(value)
}
