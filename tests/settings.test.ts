import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { configureSettingsPage } from '../src/settings.js'

/**
 * The 0.1.x `settings.register()` bridge is gone: dsh 0.2.0's SettingsForms has
 * no `register`, and its service name took the place of `settingsScope` in the
 * client, so no release ever carried both. What is left to test is the one
 * host-side call the plugin still makes — the page policy — and the fact that
 * every failure path degrades instead of throwing.
 */

/** Minimal Context stub: a logger, a fiber, and (optionally) a settings face. */
function makeCtx(
  settings?: unknown,
  options: { teardowns?: Array<() => unknown> } = {},
): Context {
  const ctx: Record<string, unknown> = {
    logger: { warn: vi.fn(), info: vi.fn() },
    fiber: { name: 'prompt-optimizer' },
  }
  if (settings !== undefined) ctx.settings = settings
  // `scopedInject` uses `ctx.inject` when present; a stub without it exercises
  // the immediate-call fallback used by the rest of this suite.
  //
  // `effect` mirrors `fiber.effect()` in cordis 4.0.1 exactly, because the
  // direction matters: `effect(cb)` invokes `cb` EAGERLY and collects its
  // *return value* as the teardown (`_execute()` → `runner.execute.call(this)`,
  // then `if (typeof effect === 'function') runner.collect(effect)`). A stub
  // that deferred `cb` to teardown time would accept a plugin that never
  // registered anything.
  if (options.teardowns !== undefined) {
    const teardowns = options.teardowns
    ctx.effect = (callback: () => unknown) => {
      const cleanup = callback()
      teardowns.push(typeof cleanup === 'function' ? (cleanup as () => unknown) : () => {})
      return () => {}
    }
  }
  return ctx as unknown as Context
}

/** Mock dsh-settings surface (structural, per `SettingsServiceLike`). */
function makeSettings() {
  const calls: { presentation?: { auto: boolean }; owner?: unknown } = {}
  const dispose = vi.fn()
  const settings = {
    configure: vi.fn((presentation: { auto: boolean }, owner?: unknown) => {
      calls.presentation = presentation
      calls.owner = owner
      return dispose
    }),
  }
  return { settings, calls, dispose }
}

describe('settings page policy (optional dsh-settings integration)', () => {
  it('stays inactive on a settings-less host', () => {
    const page = configureSettingsPage(makeCtx(undefined))
    expect(page.active).toBe(false)
  })

  it('stays inactive when a 0.1.x host exposes no configure()', () => {
    // The old host's `settings` face had `register`, not `configure`. The plugin
    // must degrade to "no page policy", never throw during construction.
    const ctx = makeCtx({ register: () => ({ get: () => ({}), update: async () => {} }) })
    const page = configureSettingsPage(ctx)
    expect(page.active).toBe(false)
    expect(ctx.logger.warn).not.toHaveBeenCalled()
  })

  it('registers the page policy with auto:false and this plugin\'s own fiber', () => {
    const { settings, calls } = makeSettings()
    const ctx = makeCtx(settings)
    const page = configureSettingsPage(ctx)
    expect(page.active).toBe(true)
    expect(settings.configure).toHaveBeenCalledTimes(1)
    // `auto: false` is the official convention for a plugin that ships its own
    // page — it stops dsh-settings from generating a second editor for the same
    // namespace. The owner must be OUR fiber, not the settings service's.
    expect(calls.presentation).toEqual({ auto: false })
    expect(calls.owner).toBe((ctx as unknown as { fiber: unknown }).fiber)
  })

  it('ties the policy to the plugin lifetime when the context offers effect()', () => {
    const { settings, dispose } = makeSettings()
    const teardowns: Array<() => unknown> = []
    const ctx = makeCtx(settings, { teardowns })
    configureSettingsPage(ctx)
    // Registering is eager, tearing down is deferred: the policy's disposer must
    // not run while the plugin lives, and the teardown must be exactly that
    // disposer (`() => dispose` returned by the effect callback), not a wrapper
    // that forgets to call it.
    expect(dispose).not.toHaveBeenCalled()
    expect(teardowns).toHaveLength(1)
    expect(teardowns[0]).toBe(dispose)
    teardowns[0]()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('degrades to inactive and warns when configure() rejects the policy', () => {
    const ctx = makeCtx({
      configure: () => {
        throw new Error('Settings presentation is already configured for this plugin instance')
      },
    })
    const page = configureSettingsPage(ctx)
    expect(page.active).toBe(false)
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
    expect(String((ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain('prompt-optimizer')
  })

  it('reports inactive until an async injection actually runs', async () => {
    // Hosts deliver the service through `ctx.inject(deps, cb)`, so the handle
    // must be usable before the callback fires — and observe the flip after.
    const { settings } = makeSettings()
    let run: (() => void) | undefined
    const ctx = {
      logger: { warn: vi.fn() },
      fiber: { name: 'prompt-optimizer' },
      settings,
      inject: (_deps: readonly string[], callback: (scoped: unknown) => void) => {
        run = () => callback(ctx)
      },
    } as unknown as Context
    const page = configureSettingsPage(ctx)
    expect(page.active).toBe(false)
    run?.()
    expect(page.active).toBe(true)
  })
})
