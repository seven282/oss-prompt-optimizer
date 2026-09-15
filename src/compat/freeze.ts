/**
 * Local recursive deep-freeze.
 *
 * Why this exists (1.8.2): the plugin used to import `deepFreeze` from
 * `@deepseek-ai/dsh-llm`, which only re-exported it. When the harness moved the
 * helper to `@deepseek-ai/dsh-util-values`, the static import failed to resolve
 * and — because Node ESM resolves static imports before evaluating the module —
 * the whole `dsh web` process refused to start. Depending on a host package for
 * a five-line utility is not worth that blast radius, so the function lives
 * here and the plugin owns its own implementation.
 *
 * Semantics are intentionally identical to the harness helper it replaces:
 * own enumerable string keys are traversed, children are frozen after their
 * parent, cycles are tolerated, and `AbortSignal` instances are skipped — an
 * `AbortSignal` carries live internal state and freezing it would break
 * cancellation.
 *
 * The traversal is iterative rather than recursive so that a deeply nested
 * config object cannot blow the call stack.
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
