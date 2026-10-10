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
