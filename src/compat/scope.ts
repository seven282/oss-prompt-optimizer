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

import type { Context } from '@deepseek-ai/cordis'

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
export function scopedInject<T extends Context>(
  ctx: T,
  deps: readonly string[],
  callback: (scoped: T) => void,
): void {
  const inject = (ctx as unknown as { inject?: unknown }).inject
  if (typeof inject === 'function') {
    try {
      const result = (inject as (names: readonly string[], cb: (scoped: T) => void) => unknown).call(
        ctx,
        deps,
        (scoped: T) => {
          runGuarded(ctx, deps, callback, scoped)
        },
      )
      // cordis returns `Fiber & PromiseLike<Fiber>`; a rejection here would
      // otherwise surface as an unhandled rejection.
      if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function') {
        void (result as PromiseLike<unknown>).then(undefined, (err: unknown) => {
          warn(ctx, deps, err)
        })
      }
      return
    } catch {
      // Older/odd `inject` shapes: fall through to the immediate call below.
    }
  }
  runGuarded(ctx, deps, callback, ctx)
}

/** Invoke the registration, downgrading a throw to a warning. */
function runGuarded<T extends Context>(
  ctx: T,
  deps: readonly string[],
  callback: (scoped: T) => void,
  scoped: T,
): void {
  try {
    callback(scoped)
  } catch (err) {
    warn(ctx, deps, err)
  }
}

/** Report a failed scoped registration without letting it escape. */
function warn(ctx: Context, deps: readonly string[], err: unknown): void {
  ctx.logger?.warn?.(
    `prompt-optimizer: scoped registration for [${deps.join(', ')}] failed; that feature is disabled`,
    err,
  )
}
