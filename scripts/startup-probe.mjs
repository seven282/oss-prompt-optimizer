#!/usr/bin/env node
/**
 * Startup-independence probe — the dynamic half of invariant I1.
 *
 * I1: no internal defect in this plugin may prevent `dsh web` from starting.
 *
 * `scripts/preflight.mjs` P1 proves the *static* half (no host package is
 * imported at runtime, so a renamed or removed export cannot break module
 * instantiation). This probe proves the behaviour end-to-end: it seals
 * **both** module systems —
 *
 *   - an ESM `resolve` hook, which rejects every `@deepseek-ai/dsh*` specifier
 *     (this is the path a static `import` would take, and its failure is
 *     uncatchable, so it is the one that took `dsh web` down in 1.8.1); and
 *   - a `Module._load` CJS interceptor, which is the path `src/compat/loader.ts`
 *     deliberately routes host access through, and which must therefore *fail
 *     softly* and be observed as a `null` capability.
 *
 * — then imports the built entry point and asserts it still instantiates. A
 * host that has upgraded past this plugin must cost features, never startup.
 *
 * Usage:  node scripts/startup-probe.mjs
 * Exit:   0 = entry loaded and degraded cleanly; 1 = startup was blocked.
 */

import Module, { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOST_SCOPE = '@deepseek-ai/dsh'

/** True for the harness itself and every `@deepseek-ai/dsh-*` domain package. */
function isHostSpecifier(specifier) {
  return specifier === HOST_SCOPE || specifier.startsWith(`${HOST_SCOPE}-`)
}

// --- Half 1: ESM resolution -------------------------------------------------
// A rejection here is exactly what a static `import '…dsh-llm'` would hit once
// the harness renames or drops the package. Nothing may depend on it.
const hooks = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === ${JSON.stringify(HOST_SCOPE)} || specifier.startsWith(${JSON.stringify(`${HOST_SCOPE}-`)})) {
    const error = new Error('simulated host upgrade: ' + specifier + ' no longer resolves')
    error.code = 'ERR_MODULE_NOT_FOUND'
    throw error
  }
  return nextResolve(specifier, context)
}
`
Module.register(`data:text/javascript,${encodeURIComponent(hooks)}`)

// --- Half 2: CJS require ----------------------------------------------------
// The compat loader must observe this as "capability absent", never as a throw.
const originalLoad = Module._load
Module._load = function patchedLoad(request, ...rest) {
  if (isHostSpecifier(request)) {
    const error = new Error(`simulated host upgrade: ${request} no longer resolves`)
    error.code = 'MODULE_NOT_FOUND'
    throw error
  }
  return originalLoad.call(this, request, ...rest)
}

const failures = []

// --- Control: prove the seal actually bites ---------------------------------
// Without this, a mis-typed scope name would seal nothing and every assertion
// below would pass vacuously. Cheap insurance against a probe that always says OK.
const requireFromRoot = createRequire(pathToFileURL(join(root, 'package.json')).href)
try {
  await import('@deepseek-ai/dsh-llm')
  failures.push('control failed: the ESM seal did not bite — @deepseek-ai/dsh-llm still resolved')
} catch {
  console.log('[PASS] control — the ESM seal rejects @deepseek-ai/dsh-llm')
}
try {
  requireFromRoot('@deepseek-ai/dsh-llm')
  failures.push('control failed: the CJS seal did not bite — require() still resolved the host')
} catch {
  console.log('[PASS] control — the CJS seal rejects require("@deepseek-ai/dsh-llm")')
}

// --- The assertion ----------------------------------------------------------
const entry = join(root, 'lib', 'index.js')
if (!existsSync(entry)) {
  console.error('startup-probe: lib/index.js is missing — run `pnpm build` first')
  process.exitCode = 1
} else {
  try {
    await import(pathToFileURL(entry).href)
    console.log('[PASS] lib/index.js instantiated with every host package sealed')
  } catch (error) {
    failures.push(
      `lib/index.js failed to instantiate: ${error?.code ?? ''} ${error?.message}`.trim(),
    )
  }

  // With the host sealed, every capability must read as absent rather than blow
  // up — that is the difference between "one feature is off" and "host is down".
  const capabilityEntry = join(root, 'lib', 'compat', 'capability.js')
  if (!existsSync(capabilityEntry)) {
    failures.push('lib/compat/capability.js is missing — run `pnpm build`')
  } else {
    try {
      const { formatCapabilitySummary, formatCompatReport, probeCapabilities } = await import(
        pathToFileURL(capabilityEntry).href
      )
      const caps = probeCapabilities()
      const missing = Object.values(caps).filter((value) => value === null).length
      if (missing !== Object.keys(caps).length) {
        failures.push(
          `probe still resolved ${Object.keys(caps).length - missing} capability(ies) while the host was sealed — the seal or the probe is lying (${formatCapabilitySummary(caps)})`,
        )
      } else {
        console.log(`[PASS] capability probe degraded cleanly (${formatCapabilitySummary(caps)})`)
      }
      const report = formatCompatReport(caps)
      if (!report.includes('DEGRADED')) {
        failures.push(`degradation is not reported to the operator: ${report}`)
      } else {
        console.log(`[PASS] degradation is reported: ${report}`)
      }
    } catch (error) {
      failures.push(`capability probe threw instead of degrading: ${error?.message}`)
    }
  }
}

if (failures.length > 0) {
  console.error('\nstartup-probe: FAILED')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('\nstartup-probe: OK — a host upgrade can cost features, never startup')
}
