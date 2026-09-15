import { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Behavioural test for the client half's `apply()`, run against a REAL cordis
 * context with only the minimum of services provided.
 *
 * The static half of rule R2 (`tests/client-inject-contract.test.ts`) proves no
 * forbidden `ctx.<name>` read exists. This file proves the thing the user
 * actually cares about: that `apply()` survives the host a real machine gives
 * it. It caught nothing in 1.8.2 — the 615-case suite and every preflight step
 * exercised `lib/index.js` (the host half) only, and the hand-written browser
 * bundle was never executed anywhere, so `ctx.locale` on line 226 shipped and
 * every real machine lost both the ✨ button and the settings page.
 *
 * The host modelled here is deliberately *minimal*: `remote` (the one injected
 * service), `slots` and — optionally — `locale`. None of `sessions` or
 * `settingsScope` is provided, because the point of the 1.8.2 refactor was that
 * their absence may cost a feature, never the registration. The last test is
 * the negative control: on this same context a direct `ctx.locale` read must
 * still throw `without inject`, otherwise the assertions above would pass for
 * the wrong reason.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = join(root, 'client', 'client.js')
const requireFromRepo = createRequire(import.meta.url)

interface ClientPluginModule {
  readonly name?: string
  readonly inject: string[]
  readonly apply: (ctx: Context) => unknown
}

interface ModuleLoaderEntry {
  readonly id: string
  readonly factory: (require: (id: string) => unknown) => ClientPluginModule
}

/**
 * Run the hand-written ModuleLoader bundle the way the harness does, and return
 * the plugin it registers.
 *
 * The file is not a module: it calls `window.__ModuleLoader__.load(...)` at top
 * level with a `factory(require)`. That factory form is what makes the browser
 * bundle testable in Node at all — the only thing it asks for is `react`, and
 * anything else is a contract violation worth failing on.
 */
function loadClientHalf(): ClientPluginModule {
  const source = readFileSync(clientPath, 'utf8')
  const captured: ModuleLoaderEntry[] = []
  const fakeWindow = {
    __ModuleLoader__: {
      load(entry: ModuleLoaderEntry) {
        captured.push(entry)
      },
    },
  }
  new Function('window', source)(fakeWindow)
  if (captured.length !== 1) {
    throw new Error(`expected exactly one ModuleLoader entry, captured ${captured.length}`)
  }
  const react = requireFromRepo('react') as Record<string, unknown>
  return captured[0].factory((id) => {
    if (id === 'react') return react
    throw new Error(`the client half asked for "${id}", which the harness does not hand to it`)
  })
}

/** `ctx.provide` with a plain string name — the typed overloads only accept known service keys. */
function provide(ctx: Context, name: string, value: unknown): void {
  ;(ctx as unknown as { provide(service: string, impl: unknown): void }).provide(name, value)
}

interface LocaleRegistration {
  readonly ns: string
  readonly dicts: Record<string, Record<string, string>>
}

interface HostRun {
  readonly inject: readonly string[]
  readonly registered: readonly string[]
  readonly locales: readonly LocaleRegistration[]
  readonly applyErrors: readonly Error[]
}

/**
 * Apply the client half on a minimal fake dsh client host.
 *
 * A throw out of `apply` is recorded rather than rethrown: cordis would report
 * it asynchronously, which turns a precise assertion into a confusing
 * unhandled rejection. The recorded error is what the first assertion prints.
 */
async function applyOnMinimalHost(options: { slots?: boolean; locale?: boolean } = {}): Promise<HostRun> {
  const plugin = loadClientHalf()
  const registered: string[] = []
  const locales: LocaleRegistration[] = []
  const applyErrors: Error[] = []

  const ctx = new Context()
  await ctx.plugin({
    name: 'fake-dsh-client-host',
    inject: [],
    apply(host) {
      provide(host, 'remote', {
        commands: {
          execute: () =>
            Promise.resolve({ ok: true, value: { result: { kind: 'success', text: 'optimized' } } }),
        },
      })
      if (options.slots !== false) {
        provide(host, 'slots', {
          // The real `slots.inject(name, cb)` defers `cb` until the slot exists;
          // calling it straight away is the same contract from `apply()`'s side.
          inject(_name: string, callback: () => unknown) {
            callback()
          },
          register(descriptor: { name: string }) {
            registered.push(descriptor.name)
            return () => {}
          },
        })
      }
      if (options.locale === true) {
        provide(host, 'locale', {
          register(ns: string, dicts: Record<string, Record<string, string>>) {
            locales.push({ ns, dicts })
          },
          bind: (ns: string) => (key: string) => `${ns}:${key}`,
        })
      }
    },
  })

  await ctx.plugin({
    name: 'oss-prompt-optimizer-client',
    inject: plugin.inject,
    async apply(scoped) {
      try {
        await plugin.apply(scoped)
      } catch (error) {
        applyErrors.push(error as Error)
      }
    },
  })

  return { inject: plugin.inject, registered, locales, applyErrors }
}

describe('client half apply() on a minimal host', () => {
  it('registers both slots on the host a real machine provides', async () => {
    // The exact 1.8.2 scenario: `slots` and `remote` present, `locale`,
    // `sessions` and `settingsScope` absent.
    const run = await applyOnMinimalHost()
    expect(run.applyErrors.map((error) => error.message)).toEqual([])
    expect([...run.registered]).toEqual(['conversation.input.left', 'settings.section'])
  })

  it('registers the locale dictionaries when the host provides a locale service', async () => {
    const run = await applyOnMinimalHost({ locale: true })
    expect(run.applyErrors).toEqual([])
    expect(run.locales).toHaveLength(1)
    expect(run.locales[0].ns).toBe('prompt-optimizer-client')
    expect(run.locales[0].dicts.zh['section.nav']).toBe('提示词优化')
    expect(run.locales[0].dicts.en['section.nav']).toBe('Prompt Optimizer')
  })

  it('still applies when the locale service is missing', async () => {
    // The whole point of the 1.8.2 refactor: a missing optional service costs a
    // feature, never the registration. Without this, `ctx.locale` in the source
    // would be "fine" as long as the test host happened to provide it.
    const run = await applyOnMinimalHost({ locale: false })
    expect(run.applyErrors).toEqual([])
    expect([...run.registered]).toEqual(['conversation.input.left', 'settings.section'])
    expect([...run.locales]).toEqual([])
  })

  it('degrades instead of throwing when the slots service is absent', async () => {
    const run = await applyOnMinimalHost({ slots: false })
    expect(run.applyErrors).toEqual([])
    expect([...run.registered]).toEqual([])
  })

  it('proves the minimal host is adversarial, so the checks above are not vacuous', async () => {
    // Negative control. If `locale` ever became available on this context — by
    // being provided at the root, or by someone adding it to `inject` — the
    // direct read would stop throwing and the tests above would keep passing
    // while the bug came back.
    const ctx = new Context()
    await ctx.plugin({
      name: 'remote-only',
      inject: [],
      apply(host) {
        provide(host, 'remote', { commands: { execute: () => Promise.resolve(undefined) } })
      },
    })

    const directReadErrors: Error[] = []
    await ctx.plugin({
      name: 'negative-control-direct-read',
      inject: ['remote'],
      apply(scoped) {
        try {
          void (scoped as unknown as Record<string, unknown>).locale
        } catch (error) {
          directReadErrors.push(error as Error)
        }
      },
    })

    expect(directReadErrors).toHaveLength(1)
    expect(directReadErrors[0].message).toContain('without inject')
    expect(directReadErrors[0].message).toContain('locale')
  })

  it('keeps the optional services out of the declared inject list', async () => {
    // `inject` is a hard gate: it is what turns a missing service into "the
    // client half never loads". These three must stay reachable only through
    // `ctx.get()`.
    const run = await applyOnMinimalHost()
    expect([...run.inject]).toContain('remote')
    for (const optional of ['locale', 'sessions', 'settingsScope', 'slots']) {
      expect([...run.inject]).not.toContain(optional)
    }
  })
})
