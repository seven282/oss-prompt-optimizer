#!/usr/bin/env node
/**
 * Client-half inject probe — the dynamic half of rule R2 (docs/兼容性策略.md).
 *
 * R2: the client half may only read a service as `ctx.<name>` when that name is
 * in its declared `inject`. Optional services go through `ctx.get('<name>')`.
 *
 * Why this probe exists: 1.8.2 cut the inject list down to `['remote']` and
 * rewrote the optional reads to `ctx.get()`, but `client/client.js` line 226
 * kept `ctx.locale`. cordis resolves `ctx.<name>` through a Proxy whose `get`
 * trap throws `cannot get property "locale" without inject` when the name is not
 * in the fiber's inject store, and `apply()` does not catch it — so the whole
 * client half failed to apply on every real machine: no ✨ button, no settings
 * page, `failed to apply loader entry …` in the console. Nothing in the 615-case
 * suite or in preflight P1–P6 noticed, because the hand-written browser bundle
 * was never *executed* by any automated step.
 *
 * This probe covers the built artifact (`lib/client.js`) and does two things:
 *
 *   1. **Static** — scan for `ctx.<name>` reads that are neither injected nor a
 *      cordis core member. The core set is *probed* against a real `Context`
 *      with nothing provided, never hard-coded: a frozen list would rot as
 *      cordis evolves, and a probe that answered "core" too readily would let
 *      every violation through.
 *   2. **Dynamic** — run the actual `apply(ctx)` against a real cordis context
 *      holding only the minimum (slots + remote, and optionally locale), and
 *      assert both slots register. A throw out of `apply` is exactly the 1.8.2
 *      failure, reproduced here instead of on a user's machine.
 *
 * Both halves carry a negative control, so a probe that always says OK is not
 * possible: the scanner is fed a snippet containing the 1.8.2 line and must flag
 * it, and the dynamic harness is fed the same mutation and must observe the
 * `without inject` throw.
 *
 * Scope, stated honestly: this checks the client half only. The host half reads
 * its services through `compat/scope.ts`'s `scopedInject()` callbacks, which a
 * line-level scan cannot reason about — it would flag every legitimate scoped
 * read. Host-side coverage stays with P1 (dependency surface) and P6 (startup
 * independence).
 *
 * Usage:  node scripts/client-probe.mjs
 * Exit:   0 = artifact satisfies R2; 1 = it does not (or a control did not bite).
 */

import { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifact = join(root, 'lib', 'client.js')
const requireFromRepo = createRequire(join(root, 'package.json'))

const failures = []

/** A check that can bite failed to bite — the probe itself is broken. */
function controlFailure(description) {
  failures.push(`control failed: ${description}`)
}

// ---------------------------------------------------------------------------
// static half — R2 over the artifact
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

/** Every `ctx.<name>` property read in executable code. */
function directContextReads(source) {
  const reads = []
  stripComments(source)
    .split('\n')
    .forEach((line, index) => {
      for (const match of line.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
        reads.push({ name: match[1], line: index + 1 })
      }
    })
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

/** Rule R2 as a pure function, so the controls exercise the real code path. */
function violationsOf(source, kernel) {
  const declared = declaredInject(source)
  if (declared === null) {
    return ['could not parse the declared `exports.inject` list — every read would pass vacuously']
  }
  const injected = new Set(declared)
  return directContextReads(source)
    .filter((read) => !injected.has(read.name) && !kernel.has(read.name))
    .map(
      (read) =>
        `lib/client.js:${read.line} reads ctx.${read.name}, which is neither injected nor a cordis core member`
        + ` — use ctx.get('${read.name}') or add it to \`inject\``,
    )
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
// dynamic half — actually run apply() on a minimal host
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
 * Apply the client half on a minimal fake dsh client host.
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
      host.provide('remote', {
        commands: {
          execute: () =>
            Promise.resolve({ ok: true, value: { result: { kind: 'success', text: 'optimized' } } }),
        },
      })
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

  return { inject: plugin.inject, registered, locales, applyErrors }
}

/** The 1.8.2 line, reintroduced on purpose for the controls. */
const REGRESSION = 'var locale = ctx.locale'
const FIXED = "var locale = ctx.get('locale')"
const SYNTHETIC = ["var inject = ['remote']", REGRESSION, 'exports.inject = inject'].join('\n')

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

if (!existsSync(artifact)) {
  console.error('client-probe: lib/client.js is missing — run `pnpm build` first')
  process.exitCode = 1
} else {
  await run()
}

async function run() {
  const source = readFileSync(artifact, 'utf8')
  const kernel = await probeKernel(PROBE_NAMES)

  // --- controls: prove both halves can bite --------------------------------
  if (!kernel.has('effect') || !kernel.has('get')) {
    controlFailure('the kernel probe found no core context members — every read would look illegal')
  } else if (kernel.has('locale') || kernel.has('slots') || kernel.has('remote')) {
    controlFailure('the kernel probe reported a service as a core member — violations would pass')
  } else {
    console.log(
      `[PASS] control — kernel probe discriminates core members (${[...kernel].sort().join(', ')})`,
    )
  }

  const syntheticViolations = violationsOf(SYNTHETIC, kernel)
  if (syntheticViolations.length !== 1 || !syntheticViolations[0].includes('reads ctx.locale')) {
    controlFailure(`the static scan did not flag a synthetic ctx.locale read (got ${JSON.stringify(syntheticViolations)})`)
  } else {
    console.log('[PASS] control — the static scan flags a synthetic `ctx.locale` read')
  }

  const controlRun = await applyOnMinimalHost(source.replace(FIXED, REGRESSION), { locale: false })
  const sawInjectError = controlRun.applyErrors.some((error) =>
    String(error && error.message).includes('without inject'),
  )
  if (!sawInjectError) {
    controlFailure('the dynamic harness did not observe the `without inject` throw on the 1.8.2 line')
  } else {
    console.log('[PASS] control — the dynamic harness reproduces the 1.8.2 `without inject` failure')
  }

  // --- the assertions -----------------------------------------------------
  const declared = declaredInject(source)
  if (declared === null) {
    failures.push('could not parse `exports.inject` from lib/client.js — the scan would be vacuous')
  } else {
    console.log(`[PASS] declared inject parsed: [${declared.join(', ')}]`)
    if (!declared.includes('remote')) {
      failures.push(`lib/client.js no longer injects "remote" — the button has no command channel (got [${declared.join(', ')}])`)
    }
    const overloaded = ['locale', 'sessions', 'settingsScope', 'slots'].filter((name) => declared.includes(name))
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
    console.log('[PASS] no direct read of a service that is neither injected nor a cordis core member')
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

  if (failures.length > 0) {
    console.error('\nclient-probe: FAILED')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
  } else {
    console.log('\nclient-probe: OK — the client half applies on the smallest host a real machine provides')
  }
}
