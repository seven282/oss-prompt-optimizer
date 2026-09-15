#!/usr/bin/env node
/**
 * Preflight gate for oss-prompt-optimizer.
 *
 * Turns the two invariants that keep this plugin from ever blocking `dsh web`
 * into commands anyone can run:
 *
 *   P1  Dependency-surface audit — `lib/**` may only statically import the
 *       framework (`@deepseek-ai/cordis`), packages this plugin installs itself
 *       (`dependencies`), and relative/node: paths. Any other bare import would
 *       fail *uncatchably* at module-instantiation time and take the host down.
 *   P2  Inject existence — every id the manifest asks the harness to resolve
 *       (`dsh.client.inject`) must actually resolve inside a real dsh profile.
 *       A dead id is what made the client bundle silently not register. The
 *       check resolves from the directory the host loads the plugin from, so it
 *       exercises Node's real lookup order (profile layer -> shared anchor ->
 *       CLI bundle) rather than a hand-maintained list of directories — those
 *       diverge, and the old list-based version could pass while the host
 *       resolved something else entirely. Falls back to enumeration (labelled
 *       approximate) only when the plugin is not installed yet.
 *       Local-only: reported as SKIP when no profile is reachable (offline CI).
 *   P3  Artifact consistency — `client/client.js` and `lib/client.js` must be
 *       byte-identical, i.e. `scripts/copy-client.mjs` was actually run.
 *   P4  typecheck -> test -> build.
 *   P5  Compatibility report — prints host versions and the runtime capability
 *       probe. Informational; never fails the run.
 *   P6  Startup independence — runs `scripts/startup-probe.mjs` in a child
 *       process that seals every `@deepseek-ai/dsh*` specifier on both the ESM
 *       and CJS paths, then imports `lib/index.js`. This is the dynamic proof of
 *       invariant I1: P1 shows no runtime host import exists, P6 shows the entry
 *       point still instantiates when the host is gone. Skipped with `--offline`
 *       only in the sense that it needs `lib/`; it never touches the network.
 *
 * Usage:  pnpm preflight  [--skip-tests] [--offline] [--dsh-home <path>]
 */

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const skipTests = argv.includes('--skip-tests')
const offline = argv.includes('--offline')
const dshHomeIndex = argv.indexOf('--dsh-home')
const dshHomeArg = dshHomeIndex === -1 ? null : (argv[dshHomeIndex + 1] ?? null)

const PASS = 'PASS'
const FAIL = 'FAIL'
const SKIP = 'SKIP'
const results = []

function record(id, title, status, detail) {
  results.push({ id, title, status, detail })
}

function readManifest() {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
}

// ---------------------------------------------------------------------------
// P1 — dependency-surface audit over the built artifacts
// ---------------------------------------------------------------------------

/** Packages that may be imported statically: the framework, plus self-installed deps. */
function staticImportAllowlist(manifest) {
  const allowed = new Set(['@deepseek-ai/cordis'])
  for (const name of Object.keys(manifest.dependencies ?? {})) allowed.add(name)
  return allowed
}

/** Recursively collect every `.js` file under `dir`. */
function collectJs(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectJs(full, acc)
    else if (entry.isFile() && entry.name.endsWith('.js')) acc.push(full)
  }
  return acc
}

/** Specifiers of every top-level static `import` / `export … from`. */
function staticSpecifiers(source) {
  const specifiers = []
  const patterns = [
    /^[ \t]*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm,
    /^[ \t]*export\s+(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/gm,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1])
  }
  return specifiers
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
function packageNameOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function checkDependencySurface(manifest) {
  const allowlist = staticImportAllowlist(manifest)
  const files = collectJs(join(root, 'lib'))
  if (files.length === 0) {
    record('P1', 'dependency surface', FAIL, 'lib/ is empty — run `pnpm build` first')
    return
  }
  const violations = []
  for (const file of files) {
    for (const specifier of staticSpecifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
      if (allowlist.has(packageNameOf(specifier))) continue
      violations.push(`${relative(root, file)} imports ${specifier}`)
    }
  }
  const detail = violations.length === 0
    ? `${files.length} artifact file(s) scanned; only ${[...allowlist].join(' + ')} imported statically`
    : `illegal host import(s):\n    ${violations.join('\n    ')}`
  record('P1', 'dependency surface', violations.length === 0 ? PASS : FAIL, detail)
}

// ---------------------------------------------------------------------------
// P2 — every `dsh.client.inject` id must resolve in a real profile
// ---------------------------------------------------------------------------

/** Candidate dsh home directories, most specific first. `--dsh-home` overrides. */
function dshHomes() {
  if (dshHomeArg) return [dshHomeArg]
  const homes = []
  if (process.env.DSH_HOME) homes.push(process.env.DSH_HOME)
  const user = process.env.USERPROFILE ?? process.env.HOME
  if (user) homes.push(join(user, '.dsh'))
  return homes
}

/** Profile directories under a dsh home, excluding the shared `node_modules` anchor. */
function dshProfileDirs(home) {
  try {
    return readdirSync(join(home, 'profiles'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
      .map((entry) => join(home, 'profiles', entry.name))
  } catch {
    return []
  }
}

/** Where the host would load this plugin from, when it is already installed. */
function installedCopy(home, packageName) {
  if (typeof packageName !== 'string' || packageName === '') return null
  for (const profile of dshProfileDirs(home)) {
    const candidate = join(profile, 'node_modules', ...packageName.split('/'))
    if (existsSync(join(candidate, 'package.json'))) return { dir: candidate, profile }
  }
  return null
}

/**
 * Which layer of the host a resolution came from. Diagnostic only.
 *
 * Node resolves symlinks to their real path by default (`--preserve-symlinks` is
 * off), so a package the profile reaches through a junction into the CLI bundle
 * reports as living outside `$DSH_HOME` — which is exactly the fact worth
 * surfacing: the profile layer was *not* what satisfied it. Both sides are
 * canonicalised before comparing, because a `$DSH_HOME` given as a symlink and
 * a resolved path on another drive make `relative()` return an absolute path,
 * which silently defeats a `startsWith('..')` test.
 */
function resolutionLayer(home, profile, resolvedPath) {
  const rel = relative(canonical(home), canonical(resolvedPath))
  if (isAbsolute(rel) || rel.startsWith('..')) return 'dsh CLI bundle'
  const forward = rel.split(sep).join('/')
  if (forward.startsWith(`profiles/${basename(profile)}/node_modules/`)) return 'plugin profile'
  if (forward.startsWith('profiles/node_modules/')) return 'shared anchor'
  return 'dsh home'
}

/** `realpathSync` that degrades to the input instead of throwing. */
function canonical(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * P2 resolves each id from the directory the host actually loads the plugin
 * from, instead of enumerating a fixed list of `node_modules` directories.
 *
 * The enumeration approach was wrong in a way that mattered: Node walks *up*
 * from the importing file, and this machine's profile layer reaches the dsh CLI
 * bundle through junctions, so the plugin's host packages came from
 * `D:\npm-global\...\dsh\node_modules\...` — a directory the old check never
 * looked at. It could therefore report PASS while the host resolved something
 * else entirely. Resolving from the real install directory cannot diverge that
 * way, because it is the same lookup the host performs.
 */
function checkInjectExistence(manifest) {
  const ids = manifest.dsh?.client?.inject ?? []
  if (ids.length === 0) {
    record('P2', 'dsh.client.inject existence', SKIP, 'manifest declares no client inject ids')
    return
  }

  let fallback = null

  for (const home of dshHomes()) {
    if (!existsSync(join(home, 'profiles'))) continue

    const installed = installedCopy(home, manifest.name)
    if (installed === null) {
      // No installed copy to anchor a faithful resolution on. Remember the
      // layers as a last resort, but keep looking for a home that has one.
      const bases = [
        join(home, 'profiles', 'web', 'node_modules'),
        join(home, 'profiles', 'node_modules'),
      ].filter((base) => existsSync(base))
      if (bases.length > 0 && fallback === null) fallback = { home, bases }
      continue
    }

    const require_ = createRequire(join(installed.dir, 'package.json'))
    const dead = []
    const layers = new Set()
    for (const id of ids) {
      try {
        layers.add(resolutionLayer(home, installed.profile, require_.resolve(id)))
      } catch (error) {
        dead.push(`${id} (${error.code ?? error.message})`)
      }
    }
    const where = relative(home, installed.dir).split(sep).join('/')
    record(
      'P2',
      'dsh.client.inject existence',
      dead.length === 0 ? PASS : FAIL,
      dead.length === 0
        ? `resolved as the host would, from ${where}: all ${ids.length} id(s) resolve via ${[...layers].join(' + ')}`
        : `resolved as the host would, from ${where}:\n    dead id(s):\n    ${dead.join('\n    ')}`,
    )
    return
  }

  if (fallback !== null) {
    const { home, bases } = fallback
    const missing = ids.filter((id) => !bases.some((base) => existsSync(join(base, ...id.split('/')))))
    record(
      'P2',
      'dsh.client.inject existence',
      missing.length === 0 ? PASS : FAIL,
      missing.length === 0
        ? `${home} — all ${ids.length} id(s) present in the profile layers (approximate: ${manifest.name} is not installed, so Node's real lookup order was not exercised)`
        : `${home} — dead id(s): ${missing.join(', ')} (approximate)`,
    )
    return
  }

  record(
    'P2',
    'dsh.client.inject existence',
    SKIP,
    'no reachable dsh profile — run locally before publishing (offline CI cannot check this)',
  )
}

// ---------------------------------------------------------------------------
// P3 — client artifact consistency
// ---------------------------------------------------------------------------

function checkArtifactConsistency() {
  const source = join(root, 'client', 'client.js')
  const artifact = join(root, 'lib', 'client.js')
  if (!existsSync(source)) {
    record('P3', 'client artifact consistency', FAIL, 'client/client.js is missing')
    return
  }
  if (!existsSync(artifact)) {
    record('P3', 'client artifact consistency', FAIL, 'lib/client.js is missing — run `pnpm build`')
    return
  }
  const a = readFileSync(source)
  const b = readFileSync(artifact)
  if (a.equals(b)) {
    record('P3', 'client artifact consistency', PASS, `lib/client.js matches client/client.js (${a.length} B)`)
  } else {
    record(
      'P3',
      'client artifact consistency',
      FAIL,
      `lib/client.js (${b.length} B) differs from client/client.js (${a.length} B) — run \`node scripts/copy-client.mjs\``,
    )
  }
}

// ---------------------------------------------------------------------------
// P4 — typecheck, test, build
// ---------------------------------------------------------------------------

/**
 * Locate a pnpm CLI entry point without depending on PATH shims resolving.
 *
 * The shim directory is scanned from `PATH` and each hit is mapped to the
 * `node_modules/pnpm/bin/pnpm.mjs` that sits beside it, because a global pnpm
 * install puts the shim at `<prefix>/pnpm.cmd` and the CLI at
 * `<prefix>/node_modules/pnpm/bin/pnpm.mjs`. Hard-coding `APPDATA/npm` misses
 * any prefix configured elsewhere (this repository's machine uses
 * `D:\npm-global`), and the `shell: true` fallback that used to catch that case
 * would happily invoke an unrelated pnpm.
 */
function findPnpmCli() {
  const candidates = [process.env.npm_execpath]
  candidates.push(join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'))
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    if (!existsSync(join(dir, 'pnpm.cmd')) && !existsSync(join(dir, 'pnpm'))) continue
    candidates.push(join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'))
  }
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null
}

function runScript(name) {
  const cli = findPnpmCli()
  if (cli === null) throw new Error('pnpm CLI not found on PATH — cannot run the build chain')
  // `--config.verify-deps-before-run=false` matters: a bare `pnpm run` re-verifies
  // the dependency graph first and, when the link farm looks stale, silently
  // reinstalls it. A toolchain check must not mutate `node_modules` — that turns a
  // read-only gate into a package-manager operation that fails for reasons that
  // have nothing to do with this plugin.
  return execFileSync(
    process.execPath,
    [cli, 'run', '--config.verify-deps-before-run=false', name],
    { cwd: root, stdio: 'pipe', encoding: 'utf8', env: process.env },
  )
}

function checkBuildChain() {
  const steps = [
    'typecheck',
    ...(skipTests ? [] : ['test']),
    'build',
  ]
  for (const name of steps) {
    try {
      runScript(name)
      record(`P4.${name}`, name, PASS, 'ok')
    } catch (error) {
      const out = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim()
      const tail = out.split(/\r?\n/).slice(-12).join('\n    ')
      record(`P4.${name}`, name, FAIL, tail || String(error.message))
      return
    }
  }
}

// ---------------------------------------------------------------------------
// P5 — compatibility report (informational)
// ---------------------------------------------------------------------------

const HOST_PACKAGES = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-timeout',
  '@deepseek-ai/cordis',
]

function checkCompatibilityReport() {
  const require_ = createRequire(pathToFileURL(join(root, 'package.json')).href)
  const versions = HOST_PACKAGES.map((name) => {
    try {
      return `${name}@${JSON.parse(readFileSync(require_.resolve(`${name}/package.json`), 'utf8')).version}`
    } catch {
      return `${name}@not-installed`
    }
  })
  let capability = 'capability probe unavailable — build the plugin first'
  const probeEntry = join(root, 'lib', 'compat', 'capability.js')
  if (existsSync(probeEntry)) {
    try {
      // Importing the built file is exactly what the host does, and the compat
      // layer is written to never throw, so this is safe even when degraded.
      const module = require_(probeEntry)
      capability = module.formatCompatReport(module.probeCapabilities())
    } catch (error) {
      capability = `capability probe failed: ${error.message}`
    }
  }
  record('P5', 'compatibility report', PASS, `${versions.join('  ')}\n    ${capability}`)
}

// ---------------------------------------------------------------------------
// P6 — startup independence (invariant I1, dynamic half)
// ---------------------------------------------------------------------------

function checkStartupIndependence() {
  const probe = join(root, 'scripts', 'startup-probe.mjs')
  if (!existsSync(probe)) {
    record('P6', 'startup independence', FAIL, 'scripts/startup-probe.mjs is missing')
    return
  }
  if (!existsSync(join(root, 'lib', 'index.js'))) {
    record('P6', 'startup independence', FAIL, 'lib/index.js is missing — run `pnpm build`')
    return
  }
  try {
    const out = execFileSync(process.execPath, [probe], {
      cwd: root,
      stdio: 'pipe',
      encoding: 'utf8',
      env: process.env,
    })
    const passes = out.split(/\r?\n/).filter((line) => line.startsWith('[PASS]'))
    record(
      'P6',
      'startup independence',
      PASS,
      `${passes.length} check(s) held with every host package sealed\n    ${passes.join('\n    ')}`,
    )
  } catch (error) {
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim()
    record('P6', 'startup independence', FAIL, out.split(/\r?\n/).slice(-10).join('\n    '))
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const manifest = readManifest()
console.log('preflight — oss-prompt-optimizer')
checkDependencySurface(manifest)
checkInjectExistence(manifest)
checkArtifactConsistency()
if (offline) record('P4', 'build chain', SKIP, 'skipped (--offline)')
else checkBuildChain()
checkCompatibilityReport()
checkStartupIndependence()

let failed = 0
for (const result of results) {
  if (result.status === FAIL) failed++
  console.log(`  [${result.status}] ${result.id.padEnd(11)} ${result.title}`)
  if (result.detail) console.log(`         ${result.detail}`)
}
console.log(`\npreflight: ${failed === 0 ? 'OK' : `${failed} check(s) FAILED`}`)
// `process.exitCode` rather than `process.exit()`: calling `process.exit()` right
// after synchronous stdio writes can trip a libuv assertion on Windows before
// the streams flush, hiding the actual result behind an abort.
process.exitCode = failed === 0 ? 0 : 1
