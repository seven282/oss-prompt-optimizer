import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createSettingsBridge } from '../src/settings.js'
import type { SettingsBridge } from '../src/settings.js'

/** Minimal Context stub carrying a logger only. */
function makeCtx(settings?: unknown): Context {
  const ctx: Record<string, unknown> = {
    logger: { warn: vi.fn(), info: vi.fn() },
  }
  if (settings !== undefined) ctx.settings = settings
  return ctx as unknown as Context
}

/** Mock dsh-settings surface (structural, per SettingsServiceLike). */
function makeSettings(userSection: Record<string, unknown> = {}) {
  let user = { ...userSection }
  const base = { temperature: 0.2, maxTokens: 1200, outputStyle: 'plain' }
  const registration = { ns: '', base: undefined as unknown }
  const settings = {
    register: vi.fn((ns: string, _schema: unknown, options?: { base?: unknown }) => {
      registration.ns = ns
      registration.base = options?.base
      return {
        get: () => ({ ...base, ...(registration.base as Record<string, unknown>), ...user }),
        update: vi.fn(async (patch: Record<string, unknown>) => {
          user = { ...user, ...patch }
        }),
      }
    }),
  }
  return { settings, registration }
}

describe('settings bridge (P0, optional dsh-settings integration)', () => {
  it('returns null when ctx.settings is not mounted (settings-less host)', () => {
    const ctx = makeCtx(undefined)
    const apply = vi.fn()
    expect(createSettingsBridge(ctx, {}, apply)).toBeNull()
    expect(apply).not.toHaveBeenCalled()
  })

  it('returns null and warns when registration fails', () => {
    const ctx = makeCtx({
      register: () => {
        throw new Error('duplicate namespace')
      },
    })
    const bridge = createSettingsBridge(ctx, {}, vi.fn())
    expect(bridge).toBeNull()
    expect(ctx.logger.warn).toHaveBeenCalled()
  })

  it('registers the namespace with the config schema and the base snapshot', () => {
    const { settings } = makeSettings()
    const ctx = makeCtx(settings)
    const base = { temperature: 0.3 }
    createSettingsBridge(ctx, base, vi.fn())
    expect(settings.register).toHaveBeenCalledTimes(1)
    const [ns, schema, options] = settings.register.mock.calls[0] as [string, unknown, { base?: unknown }]
    expect(ns).toBe('prompt-optimizer')
    expect(schema).toBeDefined()
    expect(options.base).toEqual(base)
  })

  it('sync adopts the resolved value onto the service config (defaults + base + user)', () => {
    const { settings } = makeSettings({ maxTokens: 2000 })
    const ctx = makeCtx(settings)
    const serviceConfig: Record<string, unknown> = { temperature: 0.1 }
    const bridge = createSettingsBridge(ctx, { temperature: 0.2 }, (resolved) => {
      Object.assign(serviceConfig, resolved)
    })
    expect(bridge).not.toBeNull()
    expect(bridge?.sync()).toBe(true)
    // resolved = base.temperature 0.2 (not the stale 0.1) + user maxTokens 2000
    expect(serviceConfig.temperature).toBe(0.2)
    expect(serviceConfig.maxTokens).toBe(2000)
    expect(serviceConfig.outputStyle).toBe('plain')
  })

  it('update persists a user-layer patch and re-syncs immediately', async () => {
    const { settings } = makeSettings()
    const ctx = makeCtx(settings)
    const serviceConfig: Record<string, unknown> = { temperature: 0.2 }
    const bridge = createSettingsBridge(ctx, { temperature: 0.2 }, (resolved) => {
      Object.assign(serviceConfig, resolved)
    }) as SettingsBridge
    await bridge.update({ temperature: 0.7 })
    expect(serviceConfig.temperature).toBe(0.7)
  })
})
