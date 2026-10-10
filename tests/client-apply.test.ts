import { Context, Service } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

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
 * `locale` and `configForms`. Neither `sessions` nor `configForms` is provided
 * by default, because the point of the 1.8.2 refactor was that their absence may
 * cost a feature, never the registration.
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
function loadClientHalf(reactModule?: Record<string, unknown>): ClientPluginModule {
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
  // The real `react` by default; a shim when a test needs to call a component
  // body directly (see `createReactShim`).
  const react = reactModule ?? (requireFromRepo('react') as Record<string, unknown>)
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
  /** Provide a specific `locale` service instead of the default stub (faithful face). */
  readonly localeFace?: Record<string, unknown>
  /** Mount the `remote.commands` namespace (default true). */
  readonly namespace?: boolean
  /** Mount a `configForms` face (default: none) — the 0.2.0 settings service. */
  readonly configForms?: Record<string, unknown>
  /** Hand the client half a `react` stand-in so a component body can be called. */
  readonly react?: Record<string, unknown>
}

/** One entry, as the fake slot ledger receives it. */
interface RegisteredEntry {
  readonly name: string
  readonly options: Record<string, unknown>
  readonly component: unknown
}

interface HostRun {
  readonly ctx: Context
  readonly inject: readonly string[]
  readonly registered: readonly string[]
  readonly entries: readonly RegisteredEntry[]
  readonly locales: readonly LocaleRegistration[]
  readonly applyErrors: readonly Error[]
  /** Deferred self-checks captured from `setTimeout(…, 2500)`, run by hand. */
  readonly diagnostics: readonly (() => void)[]
}

/**
 * Apply the client half on a minimal-but-faithful fake dsh client host.
 *
 * A throw out of `apply` is recorded rather than rethrown: cordis would report
 * it asynchronously, which turns a precise assertion into a confusing
 * unhandled rejection. The recorded error is what the first assertion prints.
 */
async function applyOnMinimalHost(options: HostOptions = {}): Promise<HostRun> {
  const plugin = loadClientHalf(options.react)
  const registered: string[] = []
  const entries: RegisteredEntry[] = []
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
      // `configForms` is a service like every other one on this host: mounted as
      // a real `Service` so `ctx.get('configForms')` behaves as it does on a
      // machine, and absent by default because its absence is a supported
      // deployment (the plugin still loads, the page just cannot be edited).
      if (options.configForms !== undefined) mountService(host, 'configForms', options.configForms)
      if (options.slots !== false) {
        provide(host, 'slots', {
          // The real `slots.inject(name, cb)` defers `cb` until the slot exists;
          // calling it straight away is the same contract from `apply()`'s side.
          inject(_name: string, callback: () => unknown) {
            callback()
          },
          register(descriptor: { readonly name: string } & Record<string, unknown>, component: unknown) {
            registered.push(descriptor.name)
            entries.push({ name: descriptor.name, options: descriptor, component })
            return () => {}
          },
        })
      }
      if (options.localeFace !== undefined) {
        provide(host, 'locale', options.localeFace)
      } else if (options.locale === true) {
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
  // Capture the deferred locale self-check instead of letting it fire: the file
  // schedules it 2.5 s out, which would keep the suite alive for the delay and
  // make the diagnostic untestable. Anything with a different delay is left on
  // the real timer, so this cannot silently swallow unrelated timeouts.
  const diagnostics: (() => void)[] = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    if (delay === 2500) {
      diagnostics.push(callback)
      return 0 as unknown as ReturnType<typeof realSetTimeout>
    }
    return realSetTimeout(callback, delay)
  }) as typeof globalThis.setTimeout
  try {
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
  } finally {
    globalThis.setTimeout = realSetTimeout
  }

  return { ctx, inject: plugin.inject, registered, entries, locales, applyErrors, diagnostics }
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
    // `sessions` and `configForms` absent.
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
    for (const optional of ['locale', 'configForms', 'sessions', 'slots', 'remote.commands']) {
      expect([...run.inject]).not.toContain(optional)
    }
  })
})

// ---------------------------------------------------------------------------
// locale contract (1.13.1)
//
// A user reported that after every plugin update/reinstall the settings nav row
// and the settings page were English ("Prompt Optimizer", "View status", "Core
// options only…") on a Chinese host, that it never recovered on its own, and
// that an unrelated edit to the bundle — which re-evaluates it — fixed it until
// the next update. The client half read `ctx.get('locale')` once and captured
// `locale.bind(NS)` from it.
//
// The capture was the bug, but not for the reason the report assumed: `bind()`
// returns a LIVE closure (dsh-client-locale: `(key, params) => this.translate(ns,
// key, params)`, and `translate` re-reads `snapshot.active` per call), so a stale
// binding is still language-correct *as long as the face it came from is the one
// serving the app*. What it cannot survive is the face not existing yet, or being
// replaced: a binding taken at `apply()` time only ever sees the object it took.
//
// That is a real ordering hazard rather than a theory — the locale plugin's own
// `apply()` is `async` and awaits its native bootstrap before
// `ctx.provide('locale', …)`, so this plugin's `apply()` can easily run first,
// and every label then resolves to the raw key for the whole session.
//
// The stub the tests above use (`bind: (ns) => (key) => `${ns}:${key}``) could
// never have caught any of this: it is a frozen capture in a plain object, i.e.
// the exact opposite of the real `LocaleFace` and the exact shape of the bug.
// That is the R2b lesson repeating — an unfaithful fake host makes the assertion
// pass vacuously — so the model below is derived from the runtime's source.
// ---------------------------------------------------------------------------

/**
 * A faithful stand-in for `dsh-client-locale`'s `LocaleRuntime`.
 *
 * Modelled from `lib/client.js` of the installed package, not from its README:
 *
 * - `catalog` always holds `zh` (fallback `en`) and `en`, so the fallback chain
 *   for `zh` is `['zh', 'en']` and can never skip our Chinese dictionary;
 * - `register(ns, dicts)` rejects a duplicate namespace+locale pair with
 *   `locale namespace "<ns>" already has locale "<locale>"` and registers the
 *   whole pair set atomically, publishing a revision bump;
 * - the disposer it returns removes a locale entry **only when the stored value
 *   is the same object reference**, so a newer registration survives an older
 *   fiber's cleanup;
 * - `bind(ns)` memoizes ONE closure per namespace that resolves at call time
 *   against the live snapshot and dictionaries — live, not frozen;
 * - `translate` walks the fallback chain in the entry namespace, then repeats it
 *   in `common`, then returns the key itself;
 * - `{name}` template params are substituted.
 */
interface FaithfulLocale {
  readonly service: Record<string, unknown>
  readonly setLocale: (id: string) => void
  readonly register: (ns: string, dicts: Record<string, Record<string, string>>) => () => void
  readonly bind: (ns: string) => (key: string, params?: Record<string, unknown>) => string
  readonly dictsOf: (ns: string) => ReadonlyMap<string, Record<string, string>> | undefined
}

function createFaithfulLocale(options: { readonly active?: string } = {}): FaithfulLocale {
  interface Language { readonly id: string; readonly fallback?: string }
  const catalog: Language[] = [{ id: 'zh', fallback: 'en' }, { id: 'en' }]
  const dicts = new Map<string, Map<string, Record<string, string>>>()
  const listeners = new Set<() => void>()
  const bound = new Map<string, (key: string, params?: Record<string, unknown>) => string>()
  const lower = (value: string): string => value.toLowerCase()

  let active = options.active ?? 'en'
  let revision = 0
  let snapshot = Object.freeze({ active, revision, locales: catalog.map((language) => ({ id: language.id })) })

  function fallbackChain(start: string): string[] {
    const chain: string[] = []
    const seen = new Set<string>()
    let current = catalog.find((language) => lower(language.id) === lower(start))
    while (current !== undefined && !seen.has(lower(current.id))) {
      seen.add(lower(current.id))
      chain.push(current.id)
      const next: string | undefined = current.fallback
      current = next === undefined ? undefined : catalog.find((language) => lower(language.id) === lower(next))
    }
    if (!seen.has('en')) chain.push('en')
    return chain
  }

  function lookup(ns: string, key: string, chain: readonly string[]): string | undefined {
    const locales = dicts.get(ns)
    for (const locale of chain) {
      const value = locales?.get(lower(locale))?.[key]
      if (value !== undefined) return value
    }
    return undefined
  }

  function publish(): void {
    revision += 1
    snapshot = Object.freeze({ active, revision, locales: catalog.map((language) => ({ id: language.id })) })
    for (const listener of [...listeners]) listener()
  }

  function translate(ns: string, key: string, params?: Record<string, unknown>): string {
    const chain = fallbackChain(active)
    const template = lookup(ns, key, chain)
      ?? (ns === 'common' ? undefined : lookup('common', key, chain))
      ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match)
  }

  function register(ns: string, input: Record<string, Record<string, string>>): () => void {
    const pairs = Object.entries(input)
    let locales = dicts.get(ns)
    if (locales === undefined) {
      locales = new Map()
      dicts.set(ns, locales)
    }
    for (const [locale] of pairs) {
      if (locales.has(lower(locale))) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`)
    }
    for (const [locale, entries] of pairs) locales.set(lower(locale), entries)
    publish()
    return () => {
      const owner = dicts.get(ns)
      if (owner === undefined) return
      let removed = false
      for (const [locale, entries] of pairs) {
        if (owner.get(lower(locale)) === entries) {
          owner.delete(lower(locale))
          removed = true
        }
      }
      if (removed) publish()
    }
  }

  function bind(ns: string): (key: string, params?: Record<string, unknown>) => string {
    let translator = bound.get(ns)
    if (translator === undefined) {
      translator = (key, params) => translate(ns, key, params)
      bound.set(ns, translator)
    }
    return translator
  }

  const service: Record<string, unknown> = {
    register,
    bind,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setLocale(id: string) {
      active = id
      publish()
    },
  }

  return {
    service,
    setLocale: (id) => {
      active = id
      publish()
    },
    register,
    bind,
    dictsOf: (ns) => dicts.get(ns),
  }
}

/** The registration options a slot received, by slot name. */
function descriptorOf(run: HostRun, name: string): Record<string, unknown> {
  const entry = run.entries.find((candidate) => candidate.name === name)
  if (entry === undefined) throw new Error(`no registration for slot "${name}"`)
  return entry.options
}

/** The component a slot registered, by slot name. */
function componentOf(run: HostRun, name: string): (props: unknown) => unknown {
  const entry = run.entries.find((candidate) => candidate.name === name)
  if (entry === undefined) throw new Error(`no registration for slot "${name}"`)
  return entry.component as (props: unknown) => unknown
}

/** Resolve a registered label the way the host does (thunks are called). */
function labelOf(run: HostRun, name: string): string | undefined {
  const label = descriptorOf(run, name).label
  if (label === undefined) return undefined
  return typeof label === 'function' ? (label as () => string)() : String(label)
}

/** The dictionary namespace the client half registers under. */
const NS = 'prompt-optimizer-client'

/**
 * A minimal `react` stand-in: just enough hook machinery to call a component
 * function directly and read the tree it returns.
 *
 * This repo ships neither `react-dom` nor a DOM environment — its browser half
 * is a hand-written bundle that nothing else executes — so a real renderer is
 * not available, and the alternative (asserting on source text) would not
 * notice a component that never reads its props. Calling the component and
 * walking the returned children is what makes "the page renders the active
 * language" a real behavioural assertion.
 */
function createReactShim() {
  interface Hook {
    state?: unknown
    readonly deps?: readonly unknown[]
  }
  const hooks: Hook[] = []
  let cursor = 0
  let pending: (() => unknown)[] = []
  let dirty = false

  /** Distinguish "never rendered" from "rendered with undefined". */
  const fresh = (index: number): boolean => index >= hooks.length || !('state' in hooks[index])

  const react = {
    Fragment: 'Fragment',
    createElement(type: unknown, props: unknown, ...children: unknown[]): unknown {
      return {
        type,
        props: props ?? {},
        children: children
          .flat(Infinity)
          .filter((child) => child !== null && child !== undefined && child !== false),
      }
    },
    useState<T>(initial: T): [T, (next: T | ((previous: T) => T)) => void] {
      const index = cursor++
      if (fresh(index)) hooks[index] = Object.assign({}, hooks[index], { state: initial })
      const hook = hooks[index]
      return [
        hook.state as T,
        (next) => {
          const value = typeof next === 'function' ? (next as (previous: T) => T)(hook.state as T) : next
          if (!Object.is(value, hook.state)) dirty = true
          hook.state = value
        },
      ]
    },
    useRef<T>(initial: T): { current: T } {
      const index = cursor++
      if (fresh(index)) hooks[index] = Object.assign({}, hooks[index], { state: { current: initial } })
      return hooks[index].state as { current: T }
    },
    useEffect(effect: () => unknown, deps?: readonly unknown[]): void {
      const index = cursor++
      const previous = hooks[index]
      const changed =
        previous?.deps === undefined
        || deps === undefined
        || deps.length !== previous.deps.length
        || deps.some((value, position) => !Object.is(value, previous.deps?.[position]))
      hooks[index] = { state: previous?.state, deps }
      if (changed) pending.push(effect)
    },
  }

  return {
    react,
    /**
     * Render to a fixed point and run the effects that mounted this pass.
     *
     * A single pass is not enough for anything whose first paint differs from
     * its settled paint, and the settings page is exactly that: the form is
     * looked up in a `useEffect` (because `ctx.get` must not run during a
     * render), so the first tree shows a loading/unavailable notice and every
     * input disabled. Looping until no `setState` fired is what makes the
     * returned tree the one a user would end up looking at.
     */
    render<T>(component: (props: unknown) => T, props: unknown): T {
      let tree: T | undefined
      for (let pass = 0; pass < 20; pass += 1) {
        cursor = 0
        pending = []
        dirty = false
        tree = component(props)
        for (const effect of pending.splice(0)) effect()
        if (!dirty) break
      }
      return tree as T
    },
  }
}

/** Every text node in a rendered tree, in render order (attributes excluded). */
function textOf(tree: unknown): string {
  if (typeof tree === 'string') return tree
  if (typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(textOf).join('')
  if (tree !== null && typeof tree === 'object' && 'children' in tree) {
    return textOf((tree as { children: unknown }).children)
  }
  return ''
}

/** The first `button` element in a rendered tree. */
function buttonOf(tree: unknown): { readonly props: Record<string, unknown> } {
  const children = (tree as { children?: unknown[] }).children ?? []
  for (const child of children) {
    if (child !== null && typeof child === 'object' && (child as { type?: unknown }).type === 'button') {
      return child as { readonly props: Record<string, unknown> }
    }
  }
  throw new Error('the rendered tree holds no button')
}

/** Props that satisfy the composer contract, so the ✨ button actually renders. */
function composerProps(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'session-1',
    input: { draft: 'hello' },
    inputActions: { setDraft: () => {} },
    ...extra,
  }
}

/** Provide a locale service onto a context after the fact, as a late plugin would. */
function provideLocale(ctx: Context, face: FaithfulLocale): void {
  provide(ctx, 'locale', face.service)
}

describe('client half locale contract (1.13.1)', () => {
  it('declares the locale namespace only when a face is installed', async () => {
    // The renderer throws `entry declares locale namespace … but no locale face
    // is installed (locale plugin missing from the composition?)` when a
    // registration declares a namespace nobody provides, and that throw is a
    // dead section. Declaring it unconditionally would therefore convert "this
    // host has no i18n" into "the settings page is broken".
    const without = await applyOnMinimalHost()
    expect(descriptorOf(without, 'settings.section').locale).toBeUndefined()
    expect(descriptorOf(without, 'conversation.input.left').locale).toBeUndefined()

    const with_ = await applyOnMinimalHost({ localeFace: createFaithfulLocale().service })
    expect(descriptorOf(with_, 'settings.section').locale).toBe(NS)
    expect(descriptorOf(with_, 'conversation.input.left').locale).toBe(NS)
  })

  it('follows a language switch through the same label thunk', async () => {
    // The nav row is projected from `options.label` on every ledger read, so a
    // thunk is what lets the row follow the language without re-registering
    // (`SlotLabel = string | (() => string)`).
    const face = createFaithfulLocale({ active: 'en' })
    const run = await applyOnMinimalHost({ localeFace: face.service })
    expect(run.applyErrors).toEqual([])
    expect(labelOf(run, 'settings.section')).toBe('Prompt Optimizer')

    face.setLocale('zh')
    expect(labelOf(run, 'settings.section')).toBe('提示词优化')
    expect(labelOf(run, 'conversation.input.left')).toBe('优化提示词')
  })

  it('picks up a locale service that arrives after apply(), and registers then', async () => {
    // The reported sequence. The locale plugin's `apply()` is async and awaits
    // its native bootstrap before providing the service, so this plugin's
    // `apply()` can legitimately run first — and a binding captured then is
    // blind to the face for the rest of the session.
    const run = await applyOnMinimalHost()

    const label = descriptorOf(run, 'settings.section').label as () => string
    // No face at all: the raw key, which is the documented degradation.
    expect(label()).toBe('section.nav')

    const face = createFaithfulLocale({ active: 'zh' })
    provideLocale(run.ctx, face)

    // Both halves have to be lazy for this to work: the lookup must re-resolve
    // the service, and the dictionary must be registered on that same first use.
    expect(label()).toBe('提示词优化')
    expect(face.dictsOf(NS)?.get('zh')?.['section.nav']).toBe('提示词优化')
    expect(face.dictsOf(NS)?.get('en')?.['section.nav']).toBe('Prompt Optimizer')
  })

  it('shows what a translator captured at apply() time would cost (control)', async () => {
    // The pre-1.13.1 shape, reduced to the two lines that carry it. Without this
    // the test above could pass on a host where capture and re-resolution behave
    // identically, which is exactly how the bug survived.
    const run = await applyOnMinimalHost()
    const captured = (run.ctx as unknown as { get(name: string): unknown }).get('locale')
    const translator: (key: string) => string =
      captured !== undefined && typeof (captured as { bind?: unknown }).bind === 'function'
        ? (captured as { bind(ns: string): (key: string) => string }).bind(NS)
        : (key) => key
    expect(translator('section.nav')).toBe('section.nav')

    const face = createFaithfulLocale({ active: 'zh' })
    provideLocale(run.ctx, face)
    // Same face, same dictionary for both readings below — the ONLY difference
    // is whether the translator is resolved per call.
    face.register(NS, { zh: { 'section.nav': '提示词优化' }, en: { 'section.nav': 'Prompt Optimizer' } })

    // Frozen on "there was no face": the key, forever.
    expect(translator('section.nav')).toBe('section.nav')
    // The live path the fix uses, on the same context.
    expect(face.bind(NS)('section.nav')).toBe('提示词优化')
  })

  it('survives a duplicate dictionary registration on re-activation', async () => {
    // An update re-evaluates the bundle while the previous fiber's registrations
    // may still be standing, and the runtime refuses a duplicate pair. An
    // uncaught throw here aborts `apply()` and takes the ✨ button and the
    // settings page down with it — strictly worse than reusing the copy that is
    // already installed.
    const face = createFaithfulLocale({ active: 'zh' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await applyOnMinimalHost({ localeFace: face.service })
      const second = await applyOnMinimalHost({ localeFace: face.service })

      expect(second.applyErrors).toEqual([])
      expect([...second.registered]).toEqual(['conversation.input.left', 'settings.section'])
      expect(warn.mock.calls.map((call) => String(call[0])).join(' ')).toContain(
        'dictionary registration skipped',
      )
      expect(labelOf(second, 'settings.section')).toBe('提示词优化')
    } finally {
      warn.mockRestore()
    }
  })

  it('models the duplicate-registration rejection, so the guard above is not vacuous (control)', () => {
    // Negative control for the model: if the fake face accepted a duplicate the
    // resilience test would pass while the real runtime threw.
    const face = createFaithfulLocale({ active: 'zh' })
    face.register(NS, { zh: { 'section.nav': '提示词优化' } })
    expect(() => face.register(NS, { zh: { 'section.nav': 'x' } })).toThrow(
      `locale namespace "${NS}" already has locale "zh"`,
    )
  })

  it('renders the settings page in the active language and re-renders after a switch', async () => {
    // The three strings from the report, on the page that showed them.
    const face = createFaithfulLocale({ active: 'zh' })
    const shim = createReactShim()
    const run = await applyOnMinimalHost({ localeFace: face.service, react: shim.react })
    const section = componentOf(run, 'settings.section')
    const seat = { t: face.bind(NS) }

    const chinese = textOf(shim.render(section, seat))
    expect(chinese).toContain('提示词优化')
    expect(chinese).toContain('查看运行状态')
    expect(chinese).toContain('恢复全部默认')
    expect(chinese).not.toContain('Prompt Optimizer')

    face.setLocale('en')
    const english = textOf(shim.render(section, { t: face.bind(NS) }))
    expect(english).toContain('Prompt Optimizer')
    expect(english).toContain('View status')
    expect(english).toContain('Reset all to defaults')
    expect(english).not.toContain('提示词优化')
  })

  it('re-renders on a language switch even when the host hands no seat', async () => {
    // The fallback path: a host that installed no face (or that hands components
    // no `t` seat) leaves the component's own lookup in charge, and nothing in
    // the framework would invalidate that render — the page would keep the
    // language it was first painted in. One subscription is what fixes it.
    const face = createFaithfulLocale({ active: 'zh' })
    const shim = createReactShim()
    const run = await applyOnMinimalHost({ localeFace: face.service, react: shim.react })
    const section = componentOf(run, 'settings.section')

    expect(textOf(shim.render(section, {}))).toContain('提示词优化')
    face.setLocale('en')
    expect(textOf(shim.render(section, {}))).toContain('Prompt Optimizer')
  })

  it('prefers the framework-synthesized seat when one is provided', async () => {
    // The renderer re-derives the seat per locale revision, so its identity is
    // what drives `React.memo` invalidation. A host that hands one must have it
    // honoured — asserted with a marker so a component that quietly ignored its
    // props could not pass.
    const face = createFaithfulLocale({ active: 'zh' })
    const shim = createReactShim()
    const run = await applyOnMinimalHost({ localeFace: face.service, react: shim.react })
    const section = componentOf(run, 'settings.section')

    const marked = textOf(shim.render(section, { t: (key: string) => `seat:${key}` }))
    expect(marked).toContain('seat:section.nav')
    expect(marked).not.toContain('提示词优化')
  })

  it('localizes the ✨ button title and aria label', async () => {
    // The other half of "the UI does not follow the language": the button built
    // its tooltip and accessible name from hardcoded Chinese literals.
    const face = createFaithfulLocale({ active: 'en' })
    const shim = createReactShim()
    const run = await applyOnMinimalHost({ localeFace: face.service, react: shim.react })
    const button = componentOf(run, 'conversation.input.left')

    const english = buttonOf(shim.render(button, composerProps({ t: face.bind(NS) })))
    expect(english.props.title).toBe('Optimize prompt (prompt-optimizer)')
    expect(english.props['aria-label']).toBe('Optimize prompt')

    face.setLocale('zh')
    const chinese = buttonOf(shim.render(button, composerProps({ t: face.bind(NS) })))
    expect(chinese.props.title).toBe('优化提示词 (prompt-optimizer)')
    expect(chinese.props['aria-label']).toBe('优化提示词')
  })

  it('carries a self-check that names the layer at fault and stays quiet when healthy', async () => {
    // The diagnostic exists so the next report of "the label is in the wrong
    // language" arrives with the owner already identified. Two shapes:
    // dictionary missing (ours) versus another language resolved (host's).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const healthy = await applyOnMinimalHost({ localeFace: createFaithfulLocale({ active: 'zh' }).service })
      expect(healthy.diagnostics).toHaveLength(1)
      healthy.diagnostics[0]()
      expect(warn).not.toHaveBeenCalled()

      // A face whose dictionary we could never register: `register` is absent.
      const run = await applyOnMinimalHost({
        localeFace: { bind: () => (key: string) => key, getSnapshot: () => ({ active: 'zh', revision: 1 }) },
      })
      run.diagnostics[0]()
      const message = warn.mock.calls.map((call) => String(call[0])).join(' ')
      expect(message).toContain('locale self-check')
      expect(message).toContain('active=zh')
      expect(message).toContain('our dictionary never reached the runtime')
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps every renderable string in the dictionary', async () => {
    // Guards the class of regression, not one instance: a literal that never
    // made it into both dictionaries renders as the same string in every
    // language, which no other assertion here would notice.
    const face = createFaithfulLocale({ active: 'en' })
    const run = await applyOnMinimalHost({ localeFace: face.service })
    const dicts = face.dictsOf(NS)
    const zh = dicts?.get('zh')
    const en = dicts?.get('en')
    expect(zh).toBeDefined()
    expect(en).toBeDefined()
    expect(Object.keys(zh ?? {}).sort()).toEqual(Object.keys(en ?? {}).sort())

    const keys = Object.keys(en ?? {})
    for (const key of ['btn.label', 'btn.title', 'btn.busy', 'btn.cancel', 'btn.undo', 'btn.failed',
      'announce.cancelled', 'announce.restored', 'announce.optimized', 'announce.optimized.cost',
      'error.prefix', 'error.retry', 'save.failed', 'restore.failed',
      'status.unknown.session', 'status.fetch.failed']) {
      expect(keys).toContain(key)
      expect(zh?.[key]).toBeTruthy()
      expect(en?.[key]).toBeTruthy()
      // A key that is identical in both languages is almost always a literal
      // that was wired to the wrong side of the dictionary.
      expect(zh?.[key]).not.toBe(en?.[key])
    }
    expect(labelOf(run, 'settings.section')).toBe('Prompt Optimizer')
  })
})

// ---------------------------------------------------------------------------
// settings panel contract (dsh 0.2.0: `configForms`)
//
// issue #3 was a settings page that said "saved" and wrote nothing. Two facts
// had to hold for that, and each gets its own assertion here:
//
// 1. The client read a service name (`settingsScope`) no 0.2.0 host provides, so
//    the form was never found — yet the page still rendered enabled inputs and
//    printed "current" values that came from nowhere. A panel has to be able to
//    say *why* it cannot be edited, and must not look live when it is not.
// 2. The write path ignored the answer. `ConfigForm.set()` resolves to a
//    BOOLEAN (`true` = the host accepted the change); the old code attached a
//    `.then()` that printed "saved" and never read the value, so a refused write
//    was indistinguishable from an accepted one.
//
// The model below is derived from `dsh-client-ui-settings`'s
// `ConfigFormController` / `ConfigFormSnapshot`, not from a README. Note what it
// deliberately does NOT offer: a `clear()` method (0.2.0 renamed it to `unset`,
// so a page still calling `clear` must blow up rather than no-op), and a `set()`
// that resolves `true` for convenience.
// ---------------------------------------------------------------------------

/** The eight editable keys on the page, in render order. */
const CORE_FIELDS = [
  'outputStyle', 'situationProfileLevel', 'contextAware', 'cacheEnabled',
  'optimizationProfile', 'localTemplate', 'autoOptimize', 'autoAdapt',
] as const

/** A node from the shim's `createElement` output. */
interface Element {
  readonly type: unknown
  readonly props: Record<string, unknown>
  readonly children: readonly unknown[]
}

/** Every created element in a rendered tree, depth-first. */
function elementsOf(tree: unknown, found: Element[] = []): Element[] {
  if (Array.isArray(tree)) {
    for (const child of tree) elementsOf(child, found)
    return found
  }
  if (tree === null || typeof tree !== 'object') return found
  const node = tree as Element
  if ('children' in node && 'props' in node) {
    found.push(node)
    elementsOf(node.children, found)
  }
  return found
}

/** The input/select the page rendered for one config field. */
function controlFor(tree: unknown, key: string): Element | undefined {
  return elementsOf(tree).find((node) => node.props['data-po-key'] === key)
}

/** The first element carrying exactly `className`. */
function elementWithClass(tree: unknown, className: string): Element | undefined {
  return elementsOf(tree).find((node) => node.props.className === className)
}

/**
 * A callable prop of a rendered element, or `undefined` when there is none.
 *
 * Props are `unknown` on purpose — the page builds them from plain objects — so
 * the handler is narrowed by a real `typeof` check rather than by a cast. That
 * way "the page stopped wiring `onChange`" fails as `undefined?.()` instead of
 * being papered over.
 */
function handlerOf(node: Element | undefined, name: string): ((...args: unknown[]) => unknown) | undefined {
  const handler = node?.props[name]
  return typeof handler === 'function' ? (handler as (...args: unknown[]) => unknown) : undefined
}

/** A change event shaped the way the page's one generic handler reads it. */
function changeEvent(key: string, value: string): unknown {
  return {
    target: {
      getAttribute: (name: string) => (name === 'data-po-key' ? key : null),
      value,
    },
  }
}

/** Let the page's write chains settle — they are all microtasks, no timers. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

/**
 * Capture the page's 2.5 s "flash" timer instead of scheduling it.
 *
 * Same reasoning as the locale self-check in `applyOnMinimalHost`: a real timer
 * would keep the suite alive for the delay and clear the message after the
 * assertions, so the flash would be untestable. Anything with another delay is
 * left alone, which keeps this from swallowing unrelated timeouts.
 */
function stubFlashTimers(): { readonly flashes: readonly (() => void)[]; readonly restore: () => void } {
  const flashes: (() => void)[] = []
  const real = globalThis.setTimeout
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    if (delay === 2500) {
      flashes.push(callback)
      return 0 as unknown as ReturnType<typeof real>
    }
    return real(callback, delay)
  }) as typeof globalThis.setTimeout
  return { flashes, restore: () => { globalThis.setTimeout = real } }
}

interface FieldWrite {
  readonly field: string
  readonly value: unknown
}

interface FaithfulConfigForms {
  readonly service: Record<string, unknown>
  readonly controller: Record<string, unknown>
  readonly writes: FieldWrite[]
  readonly unsets: string[]
  /** Replace the served value and publish, as a host-side edit would. */
  readonly revise: (next: Record<string, unknown>) => void
  /** How many live subscribers the page holds right now. */
  readonly subscribers: () => number
}

/**
 * A faithful stand-in for `dsh-client-ui-settings`'s `ConfigForms` face.
 *
 * - `get(entryId)` answers for the entry this host serves and for nothing else;
 *   `served: null` models a client that never received this entry's descriptor
 *   (`get()` → `undefined`), which is precisely the state issue #3 rendered as a
 *   fully editable page.
 * - the snapshot carries `status` / `writable` / `revision`, because those are
 *   what let a page say "cannot write from here" instead of lying.
 * - `set()` / `unset()` resolve the host's boolean answer and record the call,
 *   and there is no `clear()` at all.
 */
function createFaithfulConfigForms(options: {
  readonly served?: string | null
  readonly status?: 'ready' | 'loading' | 'unavailable'
  readonly writable?: boolean
  readonly accepted?: boolean
  readonly value?: Record<string, unknown>
} = {}): FaithfulConfigForms {
  const served = options.served === undefined ? 'prompt-optimizer' : options.served
  const status = options.status ?? 'ready'
  const writable = options.writable ?? true
  const accepted = options.accepted ?? true
  const writes: FieldWrite[] = []
  const unsets: string[] = []
  const listeners = new Set<() => void>()

  let value: Record<string, unknown> = { ...options.value }
  let revision = 1
  const snapshot = (): Record<string, unknown> => Object.freeze({
    status,
    value: { ...value },
    base: { ...value },
    user: {},
    revision,
    writable,
    mode: writable ? 'host' : 'memory',
  })

  const controller: Record<string, unknown> = {
    getSnapshot: snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(field: string, next: unknown): Promise<boolean> {
      writes.push({ field, value: next })
      return Promise.resolve(accepted)
    },
    unset(field: string): Promise<boolean> {
      unsets.push(field)
      return Promise.resolve(accepted)
    },
  }

  const service: Record<string, unknown> = {
    get(entryId: string) {
      return served === null || entryId !== served ? undefined : controller
    },
  }

  return {
    service,
    controller,
    writes,
    unsets,
    revise: (next) => {
      value = { ...value, ...next }
      revision += 1
      for (const listener of [...listeners]) listener()
    },
    subscribers: () => listeners.size,
  }
}

/** A marker translator: asserting on keys keeps these tests language-agnostic. */
const keys = (key: string): string => key

describe('client half settings panel on a 0.2.0 host', () => {
  it('renders the host value, enables the controls, and writes through the form', async () => {
    const forms = createFaithfulConfigForms({ value: { outputStyle: 'role-task-goal' } })
    const shim = createReactShim()
    const run = await applyOnMinimalHost({ configForms: forms.service, react: shim.react })
    expect(run.applyErrors).toEqual([])
    const section = componentOf(run, 'settings.section')

    const tree = shim.render(section, { t: keys })
    const style = controlFor(tree, 'outputStyle')
    // The value has to come from the snapshot: rendering the schema DEFAULT and
    // calling it "current" is the same lie as "saved" on a write that never
    // happened.
    expect(style?.props.value).toBe('role-task-goal')
    expect(style?.props.disabled).toBe(false)
    expect(elementWithClass(tree, 'po-reset')?.props.disabled).toBe(false)
    // A served, writable namespace shows no degradation notice at all.
    expect(textOf(tree)).not.toContain('panel.unavailable')
    expect(textOf(tree)).not.toContain('panel.loading')
    expect(textOf(tree)).not.toContain('panel.readonly')
    expect(forms.subscribers()).toBe(1)

    const timers = stubFlashTimers()
    try {
      handlerOf(style, 'onChange')?.(changeEvent('outputStyle', 'sections'))
      await flush()
      expect(forms.writes).toEqual([{ field: 'outputStyle', value: 'sections' }])
      expect(textOf(shim.render(section, { t: keys }))).toContain('savedoutputStyle')
    } finally {
      timers.restore()
    }
  })

  it('sends a boolean as a boolean, not as the string its option carries', async () => {
    // `onFieldChange` coerces by the field's declared type. Handing the host the
    // string `"false"` would be accepted by a YAML patch as a truthy string — a
    // switch that can never be turned off, reported as a successful save.
    const forms = createFaithfulConfigForms({ value: { contextAware: true } })
    const shim = createReactShim()
    const run = await applyOnMinimalHost({ configForms: forms.service, react: shim.react })
    const section = componentOf(run, 'settings.section')
    const tree = shim.render(section, { t: keys })

    const timers = stubFlashTimers()
    try {
      handlerOf(controlFor(tree, 'contextAware'), 'onChange')?.(changeEvent('contextAware', 'false'))
      await flush()
      expect(forms.writes).toEqual([{ field: 'contextAware', value: false }])
    } finally {
      timers.restore()
    }
  })

  it('reports a refused write instead of claiming a save', async () => {
    // The exact lie from issue #3, reduced to one branch. The host answers
    // `false` (nothing was written) and the page must say so.
    const forms = createFaithfulConfigForms({ accepted: false, value: { autoOptimize: true } })
    const shim = createReactShim()
    const run = await applyOnMinimalHost({ configForms: forms.service, react: shim.react })
    const section = componentOf(run, 'settings.section')
    const tree = shim.render(section, { t: keys })
    expect(controlFor(tree, 'autoOptimize')?.props.value).toBe('true')

    const timers = stubFlashTimers()
    try {
      handlerOf(controlFor(tree, 'autoOptimize'), 'onChange')?.(changeEvent('autoOptimize', 'false'))
      await flush()
      const after = textOf(shim.render(section, { t: keys }))
      expect(forms.writes).toEqual([{ field: 'autoOptimize', value: false }])
      expect(after).toContain('save.rejectedautoOptimize')
      expect(after).not.toContain('savedautoOptimize')
    } finally {
      timers.restore()
    }
  })

  it('models the boolean answer of set(), so the two panels above are not vacuous (control)', async () => {
    // Negative control for the host face itself. Both branches in the page key
    // on the RESOLVED VALUE of `set()`; a fake that always resolved `true` — or
    // resolved nothing at all, like the real one did for the old code's
    // `.then()` — would let the refused-write test pass while the bug shipped.
    const accepts = createFaithfulConfigForms({ accepted: true })
    const refuses = createFaithfulConfigForms({ accepted: false })
    expect(await (accepts.controller.set as (f: string, v: unknown) => Promise<boolean>)('outputStyle', 'sections')).toBe(true)
    expect(await (refuses.controller.set as (f: string, v: unknown) => Promise<boolean>)('outputStyle', 'sections')).toBe(false)
    // Both calls reached the host; only the answer differs.
    expect(accepts.writes).toEqual([{ field: 'outputStyle', value: 'sections' }])
    expect(refuses.writes).toEqual([{ field: 'outputStyle', value: 'sections' }])
    // And the rename is modelled: a page still calling `clear` cannot no-op.
    expect(refuses.controller.clear).toBeUndefined()
  })

  it('restores every core field through unset(), once, and says so', async () => {
    const forms = createFaithfulConfigForms({})
    const shim = createReactShim()
    const run = await applyOnMinimalHost({ configForms: forms.service, react: shim.react })
    const section = componentOf(run, 'settings.section')
    const tree = shim.render(section, { t: keys })
    const reset = elementWithClass(tree, 'po-reset')
    expect(reset?.props.disabled).toBe(false)

    const timers = stubFlashTimers()
    try {
      handlerOf(reset, 'onClick')?.()
      await flush()
      expect([...forms.unsets].sort()).toEqual([...CORE_FIELDS].sort())
      // The page claims "all defaults restored" once, after every unset landed.
      expect(textOf(shim.render(section, { t: keys }))).toContain('reset.all.done')
    } finally {
      timers.restore()
    }
  })

  it('follows the form snapshot, so a host-side change reaches the page', async () => {
    // The subscription is what makes the panel a view of the host's document
    // rather than a copy taken once. Without it a `loader/volatile-update` — or
    // any other writer — would leave the page showing a stale value.
    const forms = createFaithfulConfigForms({ value: { outputStyle: 'plain' } })
    const shim = createReactShim()
    const run = await applyOnMinimalHost({ configForms: forms.service, react: shim.react })
    const section = componentOf(run, 'settings.section')
    expect(controlFor(shim.render(section, { t: keys }), 'outputStyle')?.props.value).toBe('plain')

    forms.revise({ outputStyle: 'sections' })
    expect(controlFor(shim.render(section, { t: keys }), 'outputStyle')?.props.value).toBe('sections')
  })

  it('degrades to a disabled panel that names the cause when the entry is unknown', async () => {
    // `get()` answering `undefined` is the state a 0.1.x-named read left the page
    // in — except the old page drew live inputs anyway.
    const forms = createFaithfulConfigForms({ served: null })
    const shim = createReactShim()
    const run = await applyOnMinimalHost({ configForms: forms.service, react: shim.react })
    expect(run.applyErrors).toEqual([])
    const tree = shim.render(componentOf(run, 'settings.section'), { t: keys })

    expect(textOf(tree)).toContain('panel.unavailable')
    for (const key of CORE_FIELDS) expect(controlFor(tree, key)?.props.disabled).toBe(true)
    expect(elementWithClass(tree, 'po-reset')?.props.disabled).toBe(true)
    // Nothing was written, and nothing typed could be: the notice is the whole
    // point of rendering at all here.
    expect(forms.writes).toEqual([])
    expect(forms.unsets).toEqual([])
  })

  it('says the connection is read-only rather than pretending the fields are live', async () => {
    const forms = createFaithfulConfigForms({ writable: false })
    const shim = createReactShim()
    const run = await applyOnMinimalHost({ configForms: forms.service, react: shim.react })
    const tree = shim.render(componentOf(run, 'settings.section'), { t: keys })

    expect(textOf(tree)).toContain('panel.readonly')
    expect(textOf(tree)).not.toContain('panel.unavailable')
    expect(controlFor(tree, 'outputStyle')?.props.disabled).toBe(true)
    expect(elementWithClass(tree, 'po-reset')?.props.disabled).toBe(true)
  })

  it('applies and degrades when the host exposes no configForms service', async () => {
    // A supported deployment: the plugin still registers the ✨ button and the
    // nav row, and the page explains itself. Its absence must never cost the
    // registration (R2).
    const shim = createReactShim()
    const run = await applyOnMinimalHost({ react: shim.react })
    expect(run.applyErrors).toEqual([])
    expect([...run.registered]).toEqual(['conversation.input.left', 'settings.section'])
    const tree = shim.render(componentOf(run, 'settings.section'), { t: keys })
    expect(textOf(tree)).toContain('panel.unavailable')
    expect(controlFor(tree, 'outputStyle')?.props.disabled).toBe(true)
  })
})
