import { describe, expect, it, vi } from 'vitest'
import { scopedInject } from '../src/compat/scope.js'

/**
 * `scopedInject` has three shapes to survive: a cordis `inject` that returns a
 * fiber (a thenable — its rejection must be swallowed), an `inject` that
 * returns something else, and a context with no `inject` at all.
 */
function makeCtx(inject?: unknown) {
  const warns: unknown[][] = []
  const ctx: Record<string, unknown> = {
    logger: { warn: (...args: unknown[]) => warns.push(args) },
  }
  if (inject !== undefined) ctx.inject = inject
  return { ctx: ctx as never, warns }
}

describe('scopedInject', () => {
  it('runs the registration immediately when the context has no inject', () => {
    const { ctx } = makeCtx()
    let ran = 0
    scopedInject(ctx, ['llm'], () => { ran++ })
    expect(ran).toBe(1)
  })

  it('ignores a non-thenable return value', () => {
    const { ctx } = makeCtx((_deps: unknown, cb: (scoped: never) => void) => {
      cb(ctx)
      return { notAThenable: true }
    })
    let ran = 0
    scopedInject(ctx, ['llm'], () => { ran++ })
    expect(ran).toBe(1)
  })

  it('swallows a rejection from the returned fiber', async () => {
    const { ctx } = makeCtx(() => Promise.reject(new Error('fiber died')))
    scopedInject(ctx, ['llm'], () => {})
    // Give the rejection handler a tick to run; an unhandled rejection would
    // fail the suite instead.
    await new Promise((resolve) => setImmediate(resolve))
  })

  it('downgrades a throwing registration to a warning', () => {
    const { ctx, warns } = makeCtx()
    scopedInject(ctx, ['llm'], () => { throw new Error('registration boom') })
    expect(warns).toHaveLength(1)
    expect(String(warns[0]?.[0])).toContain('scoped registration for [llm] failed')
  })
})
