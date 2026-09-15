import { Context, Service } from '@deepseek-ai/cordis'
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
 * it, and that the services it reads really behave the way this host claims.
 *
 * History matters here, because this file has now failed to catch the same
 * class of bug twice:
 *
 * - 1.8.2 shipped `ctx.locale` (a service that had just been dropped from
 *   `inject`) on line 226 and lost the ✨ button and the settings page on every
 *   real machine.
 * - 1.8.3 fixed that but read the *nested* service `remote.commands` as
 *   `ctx.get('remote').commands`, and lost the same two things again.
 *
 * The second miss was a modelling failure, not a blind spot in the assertions:
 * `remote` was provided as a plain object literal `{ commands: {…} }`, so
 * `.commands` was an ordinary property read that could never throw. dsh's
 * `remote` is a cordis `Service`, and every remote namespace is mounted as its
 * OWN service under the dotted name `remote.<namespace>`
 * (dsh-api-gateway: `remoteServiceKey(ns) === 'remote.' + ns`). A Service value
 * returned by `ctx.get()` is wrapped in a traceable proxy whose `get` trap
 * rewrites `<assoc>.<prop>` into `ctx['<assoc>.<prop>']` whenever that dotted
 * name is a registered service (cordis `createTraceable`) — sending the read
 * back through the inject gate. `mountService()` below therefore registers real
 * `Service` instances, and a control test asserts the model is adversarial:
 * the naive read must throw here, exactly as it did on the real machine.
 *
 * The host stays deliberately *minimal* otherwise: `slots` and — optionally —
 * `locale`. Neither `sessions` nor `settingsScope` is provided, because the
 * point of the 1.8.2 refactor was that their absence may cost a feature, never
 * the registration.
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

/**
 * Register a real cordis `Service` under `name`, optionally with extra members.
 *
 * This is the difference between a host that models dsh and one that only looks
 * like it: `new Service(ctx, name)` is what makes `name` a *service*, so any
 * later `ctx.get(name)` returns a traceable proxy and nested reads go through
 * the inject gate. A plain object literal registers a name that nothing about
 * the client's reads can ever reject.
 */
function mountService(ctx: Context, name: string, members: Record<string, unknown> = {}): void {
  const ServiceCtor = Service as unknown as new (ctx: Context, name: string) => Record<string, unknown>
  Object.assign(new ServiceCtor(ctx, name), members)
}

const OPTIMIZE_REPLY = { ok: true, value: { result: { kind: 'success', text: 'optimized' } } }

interface LocaleRegistration {
  readonly ns: string
  readonly dicts: Record<string, Record<string, string>>
}

interface HostOptions {
  /** Provide `slots` at all (default true) — its absence must degrade, not throw. */
  readonly slots?: boolean
  /** Provide `locale` (default false) — the optional service the 1.8.2 outage came from. */
  readonly locale?: boolean
  /** Mount the `remote.commands` namespace (default true). */
  readonly namespace?: boolean
}

interface HostRun {
  readonly ctx: Context
  readonly inject: readonly string[]
  readonly registered: readonly string[]
  readonly locales: readonly LocaleRegistration[]
  readonly applyErrors: readonly Error[]
}

/**
 * Apply the client half on a minimal-but-faithful fake dsh client host.
 *
 * A throw out of `apply` is recorded rather than rethrown: cordis would report
 * it asynchronously, which turns a precise assertion into a confusing
 * unhandled rejection. The recorded error is what the first assertion prints.
 */
async function applyOnMinimalHost(options: HostOptions = {}): Promise<HostRun> {
  const plugin = loadClientHalf()
  const registered: string[] = []
  const locales: LocaleRegistration[] = []

  const ctx = new Context()
  await ctx.plugin({
    name: 'fake-dsh-client-host',
    inject: [],
    apply(host) {
      mountService(host, 'remote')
      if (options.namespace !== false) {
        mountService(host, 'remote.commands', {
          execute: () => Promise.resolve(OPTIMIZE_REPLY),
        })
      }
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

  const applyErrors: Error[] = []
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

  return { ctx, inject: plugin.inject, registered, locales, applyErrors }
}

/**
 * Run `body` in a plugin on `host` and collect whatever it throws.
 *
 * Reads have to happen from a *scoped* context that declares its own `inject`,
 * because that is where the gate lives: `ctx.get()` reads the store directly,
 * while `ctx.<name>` is checked against the declarer's inject list.
 */
async function probeOn(
  host: Context,
  inject: readonly string[],
  body: (ctx: Context) => unknown,
): Promise<unknown[]> {
  const thrown: unknown[] = []
  await host.plugin({
    name: `probe-${inject.join('.') || 'bare'}-${String(Math.random()).slice(2)}`,
    inject: [...inject],
    async apply(ctx) {
      try {
        thrown.push(await body(ctx))
      } catch (error) {
        thrown.push(error)
      }
    },
  })
  return thrown
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

  it('applies even when the remote.commands namespace is not mounted yet', async () => {
    // A namespace is mounted by whichever contribution carries it, which can
    // land after this plugin's `apply()` has run. Resolving the channel lazily
    // is what makes that survivable; caching the lookup at registration time
    // would have silently pinned the button to a missing channel.
    const run = await applyOnMinimalHost({ namespace: false })
    expect(run.applyErrors).toEqual([])
    expect([...run.registered]).toEqual(['conversation.input.left', 'settings.section'])
  })

  it('models the namespace rewrite, so the nested-name trap is real (control)', async () => {
    // Negative control for the host itself. `remote` is a Service and
    // `remote.commands` is a registered service, so reading `.commands` off the
    // `remote` service is rewritten into a read of the dotted service name and
    // rejected — the exact failure 1.8.3 shipped (`client.js:252`).
    const run = await applyOnMinimalHost()

    const [naive] = await probeOn(run.ctx, ['remote'], (ctx) => {
      void (ctx as unknown as { get(name: string): { commands: unknown } }).get('remote').commands
    })
    expect(naive).toBeInstanceOf(Error)
    expect((naive as Error).message).toBe('cannot get property "remote.commands" without inject')

    const [bare] = await probeOn(run.ctx, ['remote'], (ctx) => {
      void (ctx as unknown as Record<string, Record<string, unknown>>).remote.commands
    })
    expect(bare).toBeInstanceOf(Error)
    expect((bare as Error).message).toContain('remote.commands')
  })

  it('reaches the command channel by its full nested name, and it answers (control)', async () => {
    // The read the client is supposed to use. Asserting only that it does not
    // throw would accept a host where nothing is reachable at all, so the
    // round trip is asserted too.
    const run = await applyOnMinimalHost()
    const [reply] = await probeOn(run.ctx, [], async (ctx) => {
      const channel = (ctx as unknown as { get(name: string): { execute: unknown } }).get('remote.commands')
      return (channel.execute as (...args: unknown[]) => Promise<unknown>)(
        'session-1',
        '/optimize hello',
        [],
        undefined,
      )
    })
    expect(reply).toEqual(OPTIMIZE_REPLY)
  })

  it('reads an unmounted namespace as undefined rather than throwing', async () => {
    // The degradation contract for the nested read: `ctx.get()` may return
    // `undefined`, so the client must test the value instead of assuming it.
    const run = await applyOnMinimalHost({ namespace: false })
    const [value] = await probeOn(run.ctx, [], (ctx) =>
      (ctx as unknown as { get(name: string): unknown }).get('remote.commands'),
    )
    expect(value).toBeUndefined()
  })

  it('proves the minimal host is adversarial, so the checks above are not vacuous', async () => {
    // Negative control. If `locale` ever became available on this context — by
    // being provided at the root, or by someone adding it to `inject` — the
    // direct read would stop throwing and the tests above would keep passing
    // while the bug came back.
    const run = await applyOnMinimalHost()
    const [error] = await probeOn(run.ctx, ['remote'], (ctx) => {
      void (ctx as unknown as Record<string, unknown>).locale
    })
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('without inject')
    expect((error as Error).message).toContain('locale')
  })

  it('keeps the optional services out of the declared inject list', async () => {
    // `inject` is a hard gate: it is what turns a missing service into "the
    // client half never loads". These must stay reachable only through
    // `ctx.get()`. A *nested* name belongs here for the same reason: the
    // namespace may legitimately not be mounted yet.
    const run = await applyOnMinimalHost()
    expect([...run.inject]).toContain('remote')
    for (const optional of ['locale', 'sessions', 'settingsScope', 'slots', 'remote.commands']) {
      expect([...run.inject]).not.toContain(optional)
    }
  })
})
