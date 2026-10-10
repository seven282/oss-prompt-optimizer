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
 *   P7  Client inject contract (rules R2 / R2b) — runs `scripts/client-probe.mjs`
 *       against `lib/client.js`: no service read may target a name that is
 *       neither declared in `exports.inject`, a cordis core member, nor a nested
 *       service (`remote.commands`) reached through its parent; and `apply()`
 *       must actually run on a minimal but faithful host (real `Service`
 *       instances for `remote` and `remote.commands`). This is the gate that was
 *       missing twice: 1.8.2 shipped `ctx.locale` on line 226 and 1.8.3 shipped
 *       `ctx.get('remote').commands` on line 252 — a service outside `inject`
 *       throws at access time, `apply()` does not catch it, and the whole client
 *       half stops registering. Neither the test suite nor P1–P6 ever executed
 *       the hand-written browser bundle, so nothing noticed either time. The
 *       probe also re-derives the namespace roots from the installed dsh and
 *       fails when they disagree with the set it guards, so a second namespaced
 *       service upstream cannot slip past unnoticed. Local and offline: it needs
 *       `lib/` and a devDependency (`@deepseek-ai/cordis`), never the network —
 *       the derivation reports SKIP when no dsh install is present, as in CI.
 *   P8  Committed runtime artifacts — every path the manifest publishes
 *       (`main`, `types`, `exports`) must exist on disk, be **tracked by git**,
 *       and show **no diff against HEAD** under `lib/`. Staged-but-uncommitted
 *       files therefore fail: the store validates a commit, and a green index is
 *       not a commit. DSH STORE never runs install,
 *       prepare or build, so a commit that ships only `src/` is an uninstallable
 *       package while `npm publish` still looks perfectly healthy — npm rebuilds
 *       via `prepublishOnly` and honours `files`. That is exactly how
 *       oss-prompt-optimizer 1.8.4 was deferred: `lib/` was gitignored, and
 *       every published path pointed into it. This gate is why `lib/` is tracked.
 *       SKIP (with the reason) outside a git checkout, e.g. inside a tarball.
 *   P9  Desktop/web dual compatibility — reads the desktop app's own runtime
 *       (`resources/app.asar` → `dsh/package.json`, e.g.
 *       `@deepseek-ai/dsh-desktop-runtime@0.2.0-rc.2`) and fails when that
 *       version's tuple is not enumerated by `dsh.compatibility.dsh` +
 *       `dshReleases`, or when a `dsh.client.inject` package is missing from it.
 *       The desktop ships a different dsh release line than the CLI/web one, so
 *       a range that only spans one tuple silently withholds the plugin there.
 *       SKIP when no desktop install is present (CI), so the gate is portable.
 *   P10 Evaluation-grader calibration — runs
 *       `scripts/check-eval-grader.mjs` against the BUILT `lib/` artifacts and
 *       fails when the golden set is malformed (duplicate ids, a case naming an
 *       unknown rubric dimension, an injection probe without a canary), when a
 *       shipped reference pair is graded in the wrong order, or when any of the
 *       judge-parser / verdict-math reverse controls stops holding. The eval
 *       harness is what the project now uses to judge every other change, so a
 *       grader that accepts anything would report every edit as an improvement;
 *       P4 only exercises `src/`, so this is also the packaging check that the
 *       golden set and the judge actually ship inside the published bundle.
 *   P11 Settings surface in a real browser — OPT-IN (`--browser-e2e`), runs
 *       `scripts/e4-settings-browser.mjs`: a throwaway DSH_HOME, a profile
 *       composed from the shipped `web` template, `dsh web` booted on a free
 *       port, and a real Chromium — the one already installed, nothing is
 *       downloaded — completing the token→cookie handshake before it renders
 *       the settings section and writes a field through to the profile patch on
 *       disk. This is the only gate that walks the chain a user actually
 *       touches end to end (handshake → served client bundle → real
 *       `configForms` → mounted slot → disk), and issue #3 lived in exactly
 *       that gap: every fake host passed while the real page saved nothing.
 *       Not in CI and off by default, so `pnpm preflight` stays hermetic; run
 *       it from a plain shell, outside the assistant sandbox.
 *
 * Usage:  pnpm preflight  [--skip-tests] [--offline] [--dsh-home <path>] [--browser-e2e]
 */

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const skipTests = argv.includes('--skip-tests')
const offline = argv.includes('--offline')
const browserE2e = argv.includes('--browser-e2e')
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
 * from the importing file, and a real profile layer often reaches the dsh CLI
 * bundle through junctions, so the plugin's host packages can come from a
 * global-prefix directory the old check never looked at. It could therefore
 * report PASS while the host resolved something else entirely. Resolving from
 * the real install directory cannot diverge that way, because it is the same
 * lookup the host performs.
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
 * any prefix configured elsewhere (a machine whose npm prefix lives on another
 * drive, say), and the `shell: true` fallback that used to catch that case
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
  // Windows shells export a *shim* as `npm_execpath` (`pnpm.cmd` / `pnpm.ps1`),
  // and `node <shim>` dies with ERR_UNKNOWN_FILE_EXTENSION before pnpm ever runs.
  // Only a JavaScript CLI entry may be handed to `process.execPath`, so the
  // shim candidate falls through to the PATH-derived `node_modules/pnpm/bin`.
  return (
    candidates.find(
      (candidate) => candidate && /\.(mjs|cjs|js)$/.test(candidate) && existsSync(candidate),
    ) ?? null
  )
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
// P7 — client inject contract (rules R2 / R2b)
// ---------------------------------------------------------------------------

/**
 * P7 delegates to `scripts/client-probe.mjs` rather than reimplementing the
 * rules here: the probe needs a real cordis context, and the artifact it checks
 * (`lib/client.js`) is produced by P4's build, so it must run after P4 — like
 * P6. `tests/client-inject-contract.test.ts` and `tests/client-apply.test.ts`
 * cover the same rules at the source level, where `pnpm test` runs them; this
 * keeps the gate in place for `--skip-tests` runs.
 *
 * The probe's `[SKIP]` lines are surfaced in the detail rather than hidden: the
 * namespace-root derivation cannot run without a dsh install, and a skipped
 * check that reads like a passed one is how a gate rots.
 */
function checkClientInjectContract() {
  const probe = join(root, 'scripts', 'client-probe.mjs')
  if (!existsSync(probe)) {
    record('P7', 'client inject contract', FAIL, 'scripts/client-probe.mjs is missing')
    return
  }
  if (!existsSync(join(root, 'lib', 'client.js'))) {
    record('P7', 'client inject contract', FAIL, 'lib/client.js is missing — run `pnpm build`')
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
    const skips = out.split(/\r?\n/).filter((line) => line.startsWith('[SKIP]'))
    record(
      'P7',
      'client inject contract',
      PASS,
      `${passes.length} check(s) held, including the negative controls`
        + `${skips.length > 0 ? ` (skipped: ${skips.join('; ')})` : ''}\n    ${passes.join('\n    ')}`,
    )
  } catch (error) {
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim()
    record('P7', 'client inject contract', FAIL, out.split(/\r?\n/).slice(-14).join('\n    '))
  }
}

// ---------------------------------------------------------------------------
// P8 — committed runtime artifacts (the DSH STORE fixed-commit contract)
// ---------------------------------------------------------------------------

/**
 * Every path the manifest promises a consumer, flattened and de-duplicated.
 * `package.json` is dropped: it is always packed, whatever `files` says.
 */
function declaredRuntimePaths(manifest) {
  const found = []
  const push = (value) => {
    if (typeof value !== 'string') return
    if (!value.startsWith('./') && !value.startsWith('lib/')) return
    const path = value.replace(/^\.\//, '')
    if (path === 'package.json') return
    if (!found.includes(path)) found.push(path)
  }
  push(manifest.main)
  push(manifest.types)
  for (const entry of Object.values(manifest.exports ?? {})) {
    if (typeof entry === 'string') push(entry)
    else if (entry && typeof entry === 'object') {
      for (const value of Object.values(entry)) push(value)
    }
  }
  return found
}

function gitLines(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split(/\r?\n/)
    .filter(Boolean)
}

function checkCommittedRuntimeArtifacts(manifest) {
  if (!existsSync(join(root, '.git'))) {
    record('P8', 'committed runtime artifacts', SKIP, 'not a git checkout (published tarball) — nothing to compare')
    return
  }

  const declared = declaredRuntimePaths(manifest)
  if (declared.length === 0) {
    record('P8', 'committed runtime artifacts', FAIL, 'the manifest declares no runtime paths — check main/types/exports')
    return
  }

  // A gate that cannot fail proves nothing, so prove the two probes discriminate
  // before trusting them: `package.json` is tracked (so `ls-files` can say yes)
  // and `node_modules` is ignored (so `check-ignore` can say yes).
  const controls = []
  try {
    controls.push(gitLines(['ls-files', '--error-unmatch', 'package.json']).length > 0)
  } catch {
    controls.push(false)
  }
  try {
    execFileSync('git', ['check-ignore', '-q', 'node_modules'], { cwd: root, stdio: 'ignore' })
    controls.push(true)
  } catch {
    controls.push(false)
  }
  if (controls.some((ok) => !ok)) {
    record(
      'P8',
      'committed runtime artifacts',
      FAIL,
      `the probes cannot discriminate in this checkout (tracked-probe=${controls[0]}, ignore-probe=${controls[1]})`,
    )
    return
  }

  const missing = []
  const ignored = []
  const untracked = []
  for (const path of declared) {
    if (!existsSync(join(root, path))) {
      missing.push(path)
      continue
    }
    try {
      execFileSync('git', ['check-ignore', '-q', path], { cwd: root, stdio: 'ignore' })
      ignored.push(path)
    } catch {
      /* not ignored — good */
    }
    try {
      gitLines(['ls-files', '--error-unmatch', path])
    } catch {
      untracked.push(path)
    }
  }

  // `git status` cannot see ignored files, so the ignore probe above is what
  // catches the 1.8.4 shape; this one catches a rebuilt-but-uncommitted lib/.
  //
  // Staged-but-uncommitted counts as drift too. An earlier version compared the
  // worktree against the *index*, so `git add lib` made the gate go green while
  // the change still lived only in the index — and the store validates a commit,
  // not an index. `HEAD` is the right baseline because HEAD is what a pinned
  // commit resolves to.
  const drift = gitLines(['status', '--porcelain', '--', 'lib']).filter(
    (line) => line.slice(0, 2) !== '??',
  )

  const problems = []
  if (missing.length > 0) problems.push(`not on disk: ${missing.join(', ')}`)
  if (ignored.length > 0) problems.push(`gitignored: ${ignored.join(', ')}`)
  if (untracked.length > 0) problems.push(`untracked: ${untracked.join(', ')}`)
  if (drift.length > 0) problems.push(`not committed in lib/ (run: git add lib && git commit): ${drift.slice(0, 6).join(' | ')}`)

  if (problems.length > 0) {
    record('P8', 'committed runtime artifacts', FAIL, problems.join('\n    '))
    return
  }
  record(
    'P8',
    'committed runtime artifacts',
    PASS,
    `${declared.length} declared path(s) on disk, tracked and clean (${declared.join(', ')})`,
  )
}

// ---------------------------------------------------------------------------
// P9 — desktop/web dual compatibility
// ---------------------------------------------------------------------------

/**
 * The desktop app ships its own harness runtime inside an Electron `app.asar`
 * (a different dsh release line from the CLI/web one). This gate reads that
 * runtime and fails when its version tuple is not enumerated by
 * `dsh.compatibility.dsh` / `dshReleases`, or when a `dsh.client.inject` id is
 * absent from it. SKIPs when no desktop install exists, so CI stays green while
 * a developer machine with the app installed gets the real check.
 */
function checkDesktopCompatibility() {
  const script = join(root, 'scripts', 'check-desktop-compat.mjs')
  if (!existsSync(script)) {
    record('P9', 'desktop compatibility', FAIL, 'scripts/check-desktop-compat.mjs is missing')
    return
  }
  try {
    const stdout = execFileSync(process.execPath, [script], { encoding: 'utf8' })
    const text = stdout.trim()
    const first = text.split(/\r?\n/)[0] ?? ''
    const detail = text.replace(/^P9 desktop compatibility:\s*(PASS|SKIP)\s*(—\s*)?/, '')
    record('P9', 'desktop compatibility', first.includes('SKIP') ? SKIP : PASS, detail)
  } catch (error) {
    const details = [error?.stdout, error?.stderr]
      .filter((part) => typeof part === 'string' && part.trim().length > 0)
      .join('\n')
      .trim()
    record(
      'P9',
      'desktop compatibility',
      FAIL,
      details.replace(/^P9 desktop compatibility:\s*FAIL\s*(—\s*)?/, '') || String(error?.message ?? error),
    )
  }
}

// ---------------------------------------------------------------------------
// P10 — evaluation-grader calibration
// ---------------------------------------------------------------------------

/**
 * The evaluation harness is now what decides whether a change made the output
 * better, so the grader is the component most worth testing: a scorer that
 * accepts anything reports every edit as an improvement. This gate runs
 * `scripts/check-eval-grader.mjs` against the BUILT `lib/` artifacts — P4 runs
 * the suite against `src/`, which cannot catch a packaging mistake that drops
 * the golden set or the judge from the published bundle — and it asserts the
 * NEGATIVE cases (a reason-less score, a score written before its reason, a
 * fabricated dimension, a within-noise drop) so a permissive grader fails here.
 */
function checkEvalGrader() {
  const script = join(root, 'scripts', 'check-eval-grader.mjs')
  if (!existsSync(script)) {
    record('P10', 'eval grader calibration', FAIL, 'scripts/check-eval-grader.mjs is missing')
    return
  }
  try {
    const stdout = execFileSync(process.execPath, [script], { encoding: 'utf8' })
    const text = stdout.trim()
    const first = text.split(/\r?\n/)[0] ?? ''
    const detail = text.replace(/^P10 eval grader:\s*(PASS|SKIP)\s*(—\s*)?/, '')
    record('P10', 'eval grader calibration', first.includes('SKIP') ? SKIP : PASS, detail)
  } catch (error) {
    const details = [error?.stdout, error?.stderr]
      .filter((part) => typeof part === 'string' && part.trim().length > 0)
      .join('\n')
      .trim()
    record(
      'P10',
      'eval grader calibration',
      FAIL,
      details.replace(/^P10 eval grader:\s*FAIL\s*(—\s*)?/, '') || String(error?.message ?? error),
    )
  }
}

// ---------------------------------------------------------------------------
// P11 — settings surface in a real browser (opt-in: `--browser-e2e`)
// ---------------------------------------------------------------------------
/**
 * The one gate that crosses every boundary at once, and therefore the one that
 * would have caught issue #3 ("save says OK, nothing is stored"): it boots a
 * real `dsh web`, lets a real Chromium complete the token→cookie handshake,
 * loads the served client bundle, mounts the settings slot and watches a field
 * edit land in the profile patch on disk. Nothing here is faked, which is also
 * why it cannot run in CI: it needs an installed Chromium and a real host boot.
 *
 * It is read from the child's `--json` evidence rather than from stdout, because
 * unlike the other delegated probes this one prints a full human-readable log.
 */
function checkSettingsInBrowser() {
  if (!browserE2e) return
  const script = join(root, 'scripts', 'e4-settings-browser.mjs')
  if (!existsSync(script)) {
    record('P11', 'settings surface in a real browser', FAIL, 'scripts/e4-settings-browser.mjs is missing')
    return
  }
  const evidencePath = join(tmpdir(), `po-p11-${process.pid}.json`)
  try {
    execFileSync(process.execPath, [script, '--json', evidencePath], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    })
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
    const checks = Array.isArray(evidence.checks) ? evidence.checks : []
    const failed = checks.filter((c) => !c.ok).map((c) => `${c.id} ${c.label}`)
    const gaps = Array.isArray(evidence.gaps) ? evidence.gaps : []
    const detail = `${checks.filter((c) => c.ok).length}/${checks.length} check(s) — ${evidence.plugin} on ${evidence.dshHost || 'unknown host'}`
      + (failed.length ? `\n    failing: ${failed.join('; ')}` : '')
      + (gaps.length ? `\n    gaps: ${gaps.map((g) => `${g.id} ${g.label}`).join('; ')}` : '')
    record('P11', 'settings surface in a real browser', evidence.verdict === 'PASS' ? PASS : FAIL, detail)
  } catch (error) {
    const details = [error?.stdout, error?.stderr]
      .filter((part) => typeof part === 'string' && part.trim().length > 0)
      .join('\n')
      .trim()
    record(
      'P11',
      'settings surface in a real browser',
      FAIL,
      details.split(/\r?\n/).slice(-12).join('\n    ') || String(error?.message ?? error),
    )
  } finally {
    // One named file, never a pattern: this runs next to a real user's temp dir.
    if (existsSync(evidencePath)) rmSync(evidencePath, { force: true })
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
checkClientInjectContract()
checkCommittedRuntimeArtifacts(manifest)
checkDesktopCompatibility()
checkEvalGrader()
checkSettingsInBrowser()

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
