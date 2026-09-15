#!/usr/bin/env node
/**
 * Client-half inject probe — the dynamic half of rules R2 / R2b
 * (docs/兼容性策略.md), run against the *built* artifact.
 *
 * R2  — the client half may only read a service as `ctx.<name>` when that name
 *       is in its declared `inject`. Optional services go through
 *       `ctx.get('<name>')`.
 * R2b — a service whose name contains a dot is a *separate service*, and must
 *       never be reached by reading a property off its parent.
 *
 * Why this probe exists — twice over, because the same class of bug shipped
 * twice:
 *
 *   1.8.2 cut `inject` down to `['remote']` and rewrote the optional reads to
 *   `ctx.get()`, but `client/client.js` line 226 kept `ctx.locale`. cordis
 *   resolves `ctx.<name>` through a Proxy whose `get` trap throws
 *   `cannot get property "locale" without inject` when the name is not in the
 *   fiber's inject store, and `apply()` does not catch it — so the whole client
 *   half failed to apply on every real machine: no ✨ button, no settings page,
 *   `failed to apply loader entry …` in the console.
 *
 *   1.8.3 fixed that and then read the *nested* service `remote.commands` as
 *   `ctx.get('remote').commands` on line 252. The value of `ctx.get('remote')`
 *   is a cordis `Service`, and when a service with the dotted name
 *   `remote.commands` is registered — dsh-api-gateway mounts every remote
 *   namespace that way, `remoteServiceKey(ns) === 'remote.' + ns` — the
 *   traceable proxy behind the service *rewrites* the read of `.commands` into
 *   a read of `ctx['remote.commands']` (cordis `createTraceable`, the
 *   `tracker.associate` branch), which is gated again. Same throw, same outage.
 *
 * Nothing in the test suite or in preflight P1–P6 noticed either time, because
 * the hand-written browser bundle was never *executed* by any automated step.
 *
 * This probe does three things:
 *
 *   1. **Static** — scan for service reads that are neither injected nor a
 *      cordis core member, covering `ctx.<name>`, `ctx['<name>']`,
 *      `ctx.get('<name>').<child>` and the alias form
 *      (`var s = ctx.get('<name>')` … `s.<child>`). The core set is *probed*
 *      against a real `Context` with nothing provided, never hard-coded: a
 *      frozen list would rot as cordis evolves, and a probe that answered
 *      "core" too readily would let every violation through.
 *   2. **Dynamic** — run the actual `apply(ctx)` against a real cordis context
 *      that models the host faithfully: `remote` and `remote.commands` are real
 *      `Service` instances, `slots` and `locale` are plain provides. A throw out
 *      of `apply` is exactly the 1.8.2/1.8.3 failure, reproduced here instead of
 *      on a user's machine.
 *   3. **Derivation** — re-derive the namespace roots from the local dsh
 *      installation and fail when they disagree with the roots this probe
 *      assumes, so `NAMESPACE_ROOTS` cannot silently rot when dsh grows a second
 *      namespaced service. Reported as `[SKIP]` (not a pass) when no dsh install
 *      is present, which is the case in CI.
 *
 * Every half carries a negative control, so a probe that always says OK is not
 * possible: the scanner is fed the 1.8.2 line *and* the 1.8.3 line and must flag
 * both, the static scan is fed a legitimate `slots.inject()` read and must not
 * flag it, and the dynamic harness is fed both mutations and must observe the
 * `without inject` throw each time.
 *
 * Scope, stated honestly: this checks the client half only. The host half reads
 * its services through `compat/scope.ts`'s `scopedInject()` callbacks, which a
 * line-level scan cannot reason about — it would flag every legitimate scoped
 * read. Host-side coverage stays with P1 (dependency surface) and P6 (startup
 * independence).
 *
 * Usage:  node scripts/client-probe.mjs
 * Exit:   0 = artifact satisfies R2/R2b; 1 = it does not, or a control missed.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifact = join(root, 'lib', 'client.js')
const requireFromRepo = createRequire(join(root, 'package.json'))

/**
 * Services whose `<name>.<child>` are registered as separate dotted services.
 *
 * Kept narrow on purpose: the condition for the hijack is not "the parent is a
 * Service" but "`<parent>.<child>` is a registered service name", and the
 * `[derivation]` step below re-checks this list against the local dsh install.
 */
const NAMESPACE_ROOTS = ['remote']

const failures = []

/** A check that can bite failed to bite — the probe itself is broken. */
function controlFailure(description) {
  failures.push(`control failed: ${description}`)
}

// ---------------------------------------------------------------------------
// static half — R2 / R2b over the artifact
// ---------------------------------------------------------------------------

/**
 * Blank out comments while preserving line numbers. The file documents the rule
 * using the very syntax it forbids, so counting documentation as code would
 * make the scan fail on its own docblock.
 */
function stripComments(source) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
  return withoutBlocks
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//')
      if (index === -1) return line
      if (index > 0 && line[index - 1] === ':') return line // leave `https://…` alone
      return line.slice(0, index)
    })
    .join('\n')
}

/**
 * `ctx.<name>` and `ctx.<name>.<child>` reads, plus `ctx['<name>']`.
 *
 * The dotted form is reported as exactly two segments: `ctx.remote.commands.execute`
 * is a read of the service `remote.commands` whose value is then called, so
 * `remote.commands` is the actionable name. Truncating at the first dot would
 * report `remote`, which is legitimately injected and invisible to rule R2.
 */
function directContextReads(source) {
  const reads = []
  stripComments(source)
    .split('\n')
    .forEach((line, index) => {
      for (const match of line.matchAll(/\bctx\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g)) {
        reads.push({
          name: match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`,
          line: index + 1,
        })
      }
      for (const match of line.matchAll(/\bctx\[\s*['"]([^'"]+)['"]\s*\]/g)) {
        reads.push({ name: match[1], line: index + 1 })
      }
    })
  return reads
}

/**
 * Nested service names reached through their parent — the shape R2b exists for.
 *
 * Covers the inline form (`ctx.get('remote').commands`), the bracket form, and
 * the alias form (`var s = ctx.get('remote')` … `s.commands`), where the legal
 * read and the offending one sit on different lines. Only aliases of namespace
 * roots are expanded: expanding every service alias would flag `slots.inject()`
 * and `locale.bind()`, which are ordinary method reads on plain services.
 */
function nestedReads(source) {
  const clean = stripComments(source)
  const reads = []

  /** A call target followed by `.prop` or `['prop']`, captured in one match. */
  const chained = (target) =>
    new RegExp(`\\b${target}\\s*(?:\\.([A-Za-z_$][\\w$]*)|\\[\\s*['"]([^'"]+)['"]\\s*\\])`, 'g')

  const inline = chained("ctx\\.get\\(\\s*['\"]([^'\"]+)['\"]\\s*\\)")
  clean.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(inline)) {
      reads.push({ name: `${match[1]}.${match[2] ?? match[3]}`, line: index + 1 })
    }
  })

  const aliases = []
  for (const match of clean.matchAll(
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*ctx\.get\(\s*['"]([^'"]+)['"]\s*\)/g,
  )) {
    aliases.push({ local: match[1], service: match[2] })
  }
  for (const match of clean.matchAll(
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*ctx\.([A-Za-z_$][\w$]*)/g,
  )) {
    aliases.push({ local: match[1], service: match[2] })
  }
  for (const alias of aliases) {
    if (!NAMESPACE_ROOTS.includes(alias.service)) continue
    const read = chained(alias.local)
    clean.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(read)) {
        reads.push({ name: `${alias.service}.${match[1] ?? match[2]}`, line: index + 1 })
      }
    })
  }

  return reads
}

/** Every string literal in a bracketed list. */
function stringLiterals(list) {
  return [...list.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1])
}

/**
 * The service names declared via `exports.inject`. Accepts both the inlined
 * literal and the by-reference form (`var inject = ['remote']` …
 * `exports.inject = inject`). Returns `null` when no declaration is found —
 * that is a scanner failure, not an empty list.
 */
function declaredInject(source) {
  const clean = stripComments(source)
  const assignment = /exports\.inject\s*=\s*([^;\n]+)/.exec(clean)
  if (assignment === null) return null
  const value = assignment[1].trim()
  const inline = /^\[([\s\S]*)\]$/.exec(value)
  if (inline !== null) return stringLiterals(inline[1])
  if (!/^[A-Za-z_$][\w$]*$/.test(value)) return null
  const declaration = new RegExp(`\\b(?:var|let|const)\\s+${value}\\s*=\\s*\\[([^\\]]*)\\]`).exec(clean)
  return declaration === null ? null : stringLiterals(declaration[1])
}

/** Rules R2 / R2b as a pure function, so the controls exercise the real code path. */
function violationsOf(source, kernel) {
  const declared = declaredInject(source)
  if (declared === null) {
    return ['could not parse the declared `exports.inject` list — every read would pass vacuously']
  }
  const injected = new Set(declared)
  const violations = []
  const isRooted = (name) => NAMESPACE_ROOTS.includes(name.split('.')[0])

  for (const read of [...directContextReads(source), ...nestedReads(source)]) {
    // Dotted reads are only dangerous under a namespace root; everywhere else a
    // property read off a service is an ordinary read and flagging it would be
    // noise (`ctx.reflect.props`, `slots.inject`).
    if (read.name.includes('.') && !isRooted(read.name)) continue
    if (injected.has(read.name) || kernel.has(read.name)) continue
    violations.push(
      read.name.includes('.')
        ? `lib/client.js:${read.line} reads the nested service "${read.name}" as a property of its parent`
          + ` — read it as ctx.get('${read.name}'), and keep it out of \`inject\` so a namespace that`
          + ' is not mounted yet costs a feature instead of the whole client half'
        : `lib/client.js:${read.line} reads ctx.${read.name}, which is neither injected nor a cordis core member`
          + ` — use ctx.get('${read.name}') or add it to \`inject\``,
    )
  }

  for (const name of injected) {
    if (!name.includes('.')) continue
    violations.push(
      `\`inject\` lists the nested service "${name}" — a namespaced service may legitimately not be`
        + ' mounted yet, so listing it turns a missing namespace into "the client half never loads"',
    )
  }

  // A line can read the same service twice; report each finding once.
  return [...new Set(violations)]
}

/**
 * Which names resolve on a real cordis context with no service provided.
 *
 * The negative names matter as much as the positive ones: a probe that answered
 * "core" to everything would make R2 vacuous.
 */
const PROBE_NAMES = [
  'effect',
  'get',
  'inject',
  'plugin',
  'provide',
  'set',
  'logger',
  'reflect',
  'events',
  'fiber',
  'locale',
  'slots',
  'remote',
  'remote.commands',
  'sessions',
  'settingsScope',
]

async function probeKernel(names) {
  const kernel = new Set()
  const root_ = new Context()
  await root_.plugin({
    name: 'client-probe-kernel',
    inject: [],
    apply(ctx) {
      for (const name of names) {
        try {
          void ctx[name]
          kernel.add(name)
        } catch {
          // Not a core member — the case R2 is about.
        }
      }
    },
  })
  return kernel
}

// ---------------------------------------------------------------------------
// derivation — re-check NAMESPACE_ROOTS against the local dsh install
// ---------------------------------------------------------------------------

/** Candidate `@deepseek-ai` directories holding installed dsh packages. */
function deepseekScopeDirs() {
  const dirs = new Set()
  const home = process.env.DSH_HOME
  if (home) {
    const profiles = join(home, 'profiles')
    dirs.add(join(profiles, 'node_modules', '@deepseek-ai'))
    try {
      for (const entry of readdirSync(profiles, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.add(join(profiles, entry.name, 'node_modules', '@deepseek-ai'))
      }
    } catch {
      // No profiles directory — fine.
    }
  }
  try {
    // Resolves to the dsh CLI bundle, whose own node_modules holds the domain
    // packages the profile resolves against.
    const manifest = requireFromRepo.resolve('@deepseek-ai/dsh/package.json')
    dirs.add(join(dirname(manifest), 'node_modules', '@deepseek-ai'))
    dirs.add(dirname(manifest))
  } catch {
    // dsh is not installed in this tree — CI.
  }
  return [...dirs].filter((dir) => existsSync(dir))
}

/**
 * Whether a directory entry is a directory *or a link to one*.
 *
 * dsh installs its packages as junctions (they point into the pnpm store), and
 * `Dirent.isDirectory()` is false for a symlink — using it alone silently
 * skipped all 240 packages on the machine this was written on, which is how the
 * derivation first reported an empty root set.
 */
function isDirEntry(entry) {
  return entry.isDirectory() || entry.isSymbolicLink()
}

/** Every `*.js` under `dir`, skipping the duplicated type trees. */
function walkJs(dir, out, depth = 0) {
  if (depth > 6 || out.length > 20000) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (isDirEntry(entry)) {
      if (entry.name === 'node_modules' || entry.name === 'types') continue
      walkJs(path, out, depth + 1)
    } else if (entry.name.endsWith('.js')) {
      out.push(path)
    }
  }
  return out
}

/**
 * Namespace roots actually present in the installed dsh: the prefixes under
 * which a *separate* service is registered.
 *
 * Two shapes carry that evidence, and both are tied to a real registration
 * rather than to anything that merely looks dotted:
 *
 *   A. a dotted string literal in a service-registration position —
 *      `super(ctx, 'a.b')` or `ctx.provide('a.b', …)`
 *   B. a name-building function used in such a position — the shape
 *      dsh-api-gateway uses, `function remoteServiceKey(ns) { return `remote.${ns}` }`
 *      called from `super(ctx, remoteServiceKey(name))`
 *
 * A looser scan is actively wrong: matching every `` `<word>.${…}` `` template
 * dragged in resource paths (`` `config.${id}` ``, `` `conversation.${id}` ``),
 * and matching every dotted literal dragged in file names (`main.ts`,
 * `index.js`). Both would have failed the probe on a healthy install — a gate
 * that cries wolf is a gate that gets switched off.
 *
 * Returns `null` when no dsh install can be found (CI), so the caller reports a
 * skip instead of a pass.
 */
function deriveNamespaceRoots() {
  const scopes = deepseekScopeDirs()
  if (scopes.length === 0) return null

  const SERVICE_POSITION = /(?:super\([^)]*|\.provide\([^)]*?)\s*['"]([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)['"]/g
  const NAME_BUILDER = /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*return\s+`([A-Za-z_$][\w$]*)\.\$\{/g

  const roots = new Set()
  for (const scope of scopes) {
    for (const entry of readdirSync(scope, { withFileTypes: true })) {
      if (!isDirEntry(entry) || !entry.name.startsWith('dsh-')) continue
      for (const file of walkJs(join(scope, entry.name, 'lib'), [])) {
        let text
        try {
          if (statSync(file).size > 4 * 1024 * 1024) continue
          text = readFileSync(file, 'utf8')
        } catch {
          continue
        }
        for (const match of text.matchAll(SERVICE_POSITION)) roots.add(match[1].split('.')[0])
        for (const match of text.matchAll(NAME_BUILDER)) {
          const builder = match[1]
          const used = new RegExp(
            `super\\([^)]*\\b${builder}\\s*\\(|\\.provide\\([^)]*\\b${builder}\\s*\\(`,
          ).test(text)
          if (used) roots.add(match[2])
        }
      }
    }
  }
  return [...roots].sort()
}

// ---------------------------------------------------------------------------
// dynamic half — actually run apply() on a faithful minimal host
// ---------------------------------------------------------------------------

/**
 * Run the hand-written ModuleLoader bundle the way the harness does.
 *
 * The file is not a module: it calls `window.__ModuleLoader__.load({factory})`
 * at top level. The factory only ever asks for `react`, and anything else is a
 * contract violation worth failing on.
 */
function loadClientHalf(source) {
  const captured = []
  const fakeWindow = { __ModuleLoader__: { load: (entry) => captured.push(entry) } }
  new Function('window', source)(fakeWindow)
  if (captured.length !== 1) {
    throw new Error(`expected exactly one ModuleLoader entry, captured ${captured.length}`)
  }
  const react = requireFromRepo('react')
  return captured[0].factory((id) => {
    if (id === 'react') return react
    throw new Error(`the client half asked for "${id}", which the harness does not hand to it`)
  })
}

/**
 * Register a real cordis `Service` under `name`, optionally with extra members.
 *
 * This is the difference between a host that models dsh and one that only looks
 * like it: `new Service(ctx, name)` makes `name` a *service*, so a later
 * `ctx.get(name)` returns a traceable proxy and nested reads go through the
 * inject gate. A plain object literal registers a name that nothing about the
 * client's reads can ever reject — which is why the 1.8.3 outage passed the
 * previous version of this probe.
 */
function mountService(ctx, name, members = {}) {
  Object.assign(new Service(ctx, name), members)
}

const OPTIMIZE_REPLY = { ok: true, value: { result: { kind: 'success', text: 'optimized' } } }

/**
 * Apply the client half on a minimal-but-faithful fake dsh client host.
 *
 * A throw out of `apply` is recorded rather than rethrown: cordis reports it
 * asynchronously, which would turn a precise failure line into an unhandled
 * rejection.
 */
async function applyOnMinimalHost(source, options = {}) {
  const plugin = loadClientHalf(source)
  const registered = []
  const locales = []
  const applyErrors = []

  const ctx = new Context()
  await ctx.plugin({
    name: 'fake-dsh-client-host',
    inject: [],
    apply(host) {
      mountService(host, 'remote')
      if (options.namespace !== false) {
        mountService(host, 'remote.commands', { execute: () => Promise.resolve(OPTIMIZE_REPLY) })
      }
      if (options.slots !== false) {
        host.provide('slots', {
          inject(_name, callback) {
            callback()
          },
          register(descriptor) {
            registered.push(descriptor.name)
            return () => {}
          },
        })
      }
      if (options.locale === true) {
        host.provide('locale', {
          register(ns, dicts) {
            locales.push({ ns, dicts })
          },
          bind: (ns) => (key) => `${ns}:${key}`,
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
        applyErrors.push(error)
      }
    },
  })

  return { ctx, inject: plugin.inject, registered, locales, applyErrors }
}

/**
 * Run `body` in a plugin on `host` and report what it threw (or returned).
 *
 * Reads must happen from a *scoped* context that declares its own `inject`,
 * because that is where the gate lives: `ctx.get()` reads the store directly,
 * while `ctx.<name>` is checked against the declarer's inject list.
 */
let probeSequence = 0
async function probeOn(host, inject, body) {
  const outcome = []
  await host.plugin({
    name: `probe-${inject.join('.') || 'bare'}-${++probeSequence}`,
    inject: [...inject],
    async apply(ctx) {
      try {
        outcome.push(await body(ctx))
      } catch (error) {
        outcome.push(error)
      }
    },
  })
  return outcome[0]
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const REGRESSION_182 = 'var locale = ctx.locale'
const FIXED_182 = "var locale = ctx.get('locale')"
const SYNTHETIC_182 = ["var inject = ['remote']", REGRESSION_182, 'exports.inject = inject'].join('\n')

const SYNTHETIC_183 = [
  "var inject = ['remote']",
  'var channel = ctx.get(\'remote\').commands',
  'exports.inject = inject',
].join('\n')

const LEGITIMATE = [
  "var inject = ['remote']",
  "var slots = ctx.get('slots')",
  "slots.inject('conversation.input.left', function () {})",
  "var channel = ctx.get('remote.commands')",
  'channel.execute(sessionId, line, args, signal)',
  'exports.inject = inject',
].join('\n')

if (!existsSync(artifact)) {
  console.error('client-probe: lib/client.js is missing — run `pnpm build` first')
  process.exitCode = 1
} else {
  await run()
}

async function run() {
  const source = readFileSync(artifact, 'utf8')
  const kernel = await probeKernel(PROBE_NAMES)

  // --- controls: prove every half can bite ---------------------------------
  if (!kernel.has('effect') || !kernel.has('get')) {
    controlFailure('the kernel probe found no core context members — every read would look illegal')
  } else if (kernel.has('locale') || kernel.has('slots') || kernel.has('remote') || kernel.has('remote.commands')) {
    controlFailure('the kernel probe reported a service as a core member — violations would pass')
  } else {
    console.log(
      `[PASS] control — kernel probe discriminates core members (${[...kernel].sort().join(', ')})`,
    )
  }

  const synthetic182 = violationsOf(SYNTHETIC_182, kernel)
  if (synthetic182.length !== 1 || !synthetic182[0].includes('reads ctx.locale')) {
    controlFailure(
      `the static scan did not flag a synthetic ctx.locale read (got ${JSON.stringify(synthetic182)})`,
    )
  } else {
    console.log('[PASS] control — the static scan flags a synthetic `ctx.locale` read (1.8.2)')
  }

  const synthetic183 = violationsOf(SYNTHETIC_183, kernel)
  if (synthetic183.length !== 1 || !synthetic183[0].includes('reads the nested service "remote.commands"')) {
    controlFailure(
      `the static scan did not flag a synthetic nested-service read (got ${JSON.stringify(synthetic183)})`,
    )
  } else {
    console.log('[PASS] control — the static scan flags a nested-service read (1.8.3)')
  }

  const legitimate = violationsOf(LEGITIMATE, kernel)
  if (legitimate.length !== 0) {
    controlFailure(
      'the static scan flags ordinary method reads on non-namespaced services'
      + ` — it would be weakened until it caught nothing (got ${JSON.stringify(legitimate)})`,
    )
  } else {
    console.log('[PASS] control — the static scan leaves `slots.inject()` / `ctx.get(\'remote.commands\')` alone')
  }

  // Control: on this host the naive nested read must throw, exactly as it did
  // on a real machine. Without it, a host that quietly stopped modelling the
  // namespace rewrite would make every dynamic assertion below vacuous.
  const faithful = await applyOnMinimalHost(source, { locale: false })
  const naive = await probeOn(faithful.ctx, ['remote'], (ctx) => ctx.get('remote').commands)
  if (!(naive instanceof Error) || !String(naive.message).includes('without inject')) {
    controlFailure(
      "the host model is not adversarial: `ctx.get('remote').commands` did not throw,"
        + ' so a passing run would prove nothing',
    )
  } else {
    console.log(`[PASS] control — the host model is adversarial ("${naive.message}")`)
  }

  const controlRun182 = await applyOnMinimalHost(source.replace(FIXED_182, REGRESSION_182), { locale: false })
  if (!controlRun182.applyErrors.some((error) => String(error && error.message).includes('without inject'))) {
    controlFailure('the dynamic harness did not observe the `without inject` throw on the 1.8.2 line')
  } else {
    console.log('[PASS] control — the dynamic harness reproduces the 1.8.2 `without inject` failure')
  }

  // Control for the 1.8.3 failure mode. The fixed artifact resolves the channel
  // lazily, *inside* `executeCommand`, which `apply()` never calls — so mutating
  // that line alone would change nothing at runtime and would prove nothing.
  // What 1.8.3 actually did was resolve it eagerly while `apply()` ran, so the
  // control injects exactly that: one nested read on the apply path.
  const EAGER_ANCHOR = "var slots = ctx.get('slots')"
  const controlRun183 = await applyOnMinimalHost(
    source.replace(EAGER_ANCHOR, `${EAGER_ANCHOR}\n      var probeEager = ctx.get('remote').commands`),
    { locale: false },
  )
  const nestedMessage = controlRun183.applyErrors
    .map((error) => String(error && error.message))
    .find((message) => message.includes('remote.commands'))
  if (nestedMessage === undefined || !nestedMessage.includes('without inject')) {
    controlFailure(
      'the dynamic harness did not reproduce the 1.8.3 nested-service failure — the host model has'
      + ' stopped being faithful, so a passing run would prove nothing'
      + ` (got ${JSON.stringify(controlRun183.applyErrors.map((error) => String(error && error.message)))})`,
    )
  } else {
    console.log(`[PASS] control — the dynamic harness reproduces the 1.8.3 failure ("${nestedMessage}")`)
  }

  // --- derivation: NAMESPACE_ROOTS against the real install ----------------
  const derived = deriveNamespaceRoots()
  if (derived === null) {
    console.log('[SKIP] derivation — no dsh install found, namespace roots not re-checked (CI)')
  } else {
    const assumed = [...NAMESPACE_ROOTS].sort()
    if (derived.join(',') !== assumed.join(',')) {
      failures.push(
        `the installed dsh registers namespaced services under [${derived.join(', ')}] but this probe`
        + ` only guards [${assumed.join(', ')}] — update NAMESPACE_ROOTS in scripts/client-probe.mjs and`
        + ' tests/client-inject-contract.test.ts, then re-check the client half for nested reads',
      )
    } else {
      console.log(`[PASS] derivation — installed dsh namespace roots match [${assumed.join(', ')}]`)
    }
  }

  // --- the assertions -----------------------------------------------------
  const declared = declaredInject(source)
  if (declared === null) {
    failures.push('could not parse `exports.inject` from lib/client.js — the scan would be vacuous')
  } else {
    console.log(`[PASS] declared inject parsed: [${declared.join(', ')}]`)
    if (!declared.includes('remote')) {
      failures.push(
        `lib/client.js no longer injects "remote" — the button has no command channel (got [${declared.join(', ')}])`,
      )
    }
    const overloaded = ['locale', 'sessions', 'settingsScope', 'slots', 'remote.commands'].filter((name) =>
      declared.includes(name),
    )
    if (overloaded.length > 0) {
      failures.push(
        `lib/client.js injects optional service(s) [${overloaded.join(', ')}] — inject is a hard gate,`
        + ' so their absence would stop the whole client half from loading (read them with ctx.get())',
      )
    } else {
      console.log('[PASS] inject holds only services the client half cannot work without')
    }
  }

  const violations = violationsOf(source, kernel)
  if (violations.length > 0) {
    for (const violation of violations) failures.push(violation)
  } else {
    console.log('[PASS] no read of a service that is neither injected, a core member, nor reached as a nested name')
  }

  let run_
  try {
    run_ = await applyOnMinimalHost(source, { locale: false })
  } catch (error) {
    failures.push(`apply() threw out of the harness: ${error && error.message}`)
    run_ = null
  }
  if (run_ !== null) {
    const messages = run_.applyErrors.map((error) => String(error && error.message))
    if (messages.length > 0) {
      failures.push(`apply() failed on a minimal host: ${messages.join(' | ')}`)
    } else if (run_.registered.join(',') !== 'conversation.input.left,settings.section') {
      failures.push(
        `apply() registered [${run_.registered.join(', ')}] instead of both slots`
        + ' — the button and/or the settings page would be missing',
      )
    } else {
      console.log('[PASS] apply() registers both slots on a host with only slots + remote provided')
    }
  }

  try {
    const late = await applyOnMinimalHost(source, { namespace: false })
    if (late.applyErrors.length > 0) {
      failures.push(
        `apply() failed when the remote.commands namespace is not mounted yet: ${late.applyErrors.map((error) => String(error && error.message)).join(' | ')}`,
      )
    } else if (late.registered.join(',') !== 'conversation.input.left,settings.section') {
      failures.push('apply() did not register both slots when the namespace is absent')
    } else {
      console.log('[PASS] apply() survives a host where the remote.commands namespace is not mounted yet')
    }
  } catch (error) {
    failures.push(`the late-namespace path threw out of the harness: ${error && error.message}`)
  }

  try {
    const withLocale = await applyOnMinimalHost(source, { locale: true })
    const registration = withLocale.locales[0]
    if (withLocale.locales.length !== 1) {
      failures.push(
        `the locale dictionaries were not registered (${withLocale.locales.length} registration(s))`
        + ' — the settings page would show raw keys instead of labels',
      )
    } else if (registration.ns !== 'prompt-optimizer-client' || !registration.dicts.zh || !registration.dicts.en) {
      failures.push(`locale registration looks wrong: ns=${registration.ns}`)
    } else {
      console.log(`[PASS] locale dictionaries registered as ${registration.ns} (zh + en)`)
    }
  } catch (error) {
    failures.push(`the locale path threw out of the harness: ${error && error.message}`)
  }

  // The command channel must be reachable *and* answer on the faithful host.
  try {
    const host = await applyOnMinimalHost(source, { locale: false })
    const channel = await probeOn(host.ctx, [], (ctx) => ctx.get('remote.commands'))
    if (typeof channel !== 'object' || channel === null || typeof channel.execute !== 'function') {
      failures.push('ctx.get(\'remote.commands\') did not yield a channel with execute() on the faithful host')
    } else {
      const reply = await probeOn(host.ctx, [], (ctx) =>
        ctx.get('remote.commands').execute('session-1', '/optimize hello', [], undefined),
      )
      if (reply !== OPTIMIZE_REPLY) {
        failures.push(`the command channel did not answer correctly on the faithful host (got ${JSON.stringify(reply)})`)
      } else {
        console.log('[PASS] ctx.get(\'remote.commands\').execute() round-trips on the faithful host')
      }
    }
  } catch (error) {
    failures.push(`the nested-channel path threw out of the harness: ${error && error.message}`)
  }

  if (failures.length > 0) {
    console.error('\nclient-probe: FAILED')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
  } else {
    console.log('\nclient-probe: OK — the client half applies on the smallest host a real machine provides')
  }
}
