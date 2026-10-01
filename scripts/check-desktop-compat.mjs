#!/usr/bin/env node
/**
 * P9 — desktop/web dual compatibility check.
 *
 * The desktop app ships its own harness runtime inside an Electron `app.asar`
 * (`dsh/`), e.g. `@deepseek-ai/dsh-desktop-runtime@0.2.0-rc.2`. That runtime is
 * a *different* dsh release line from the CLI/web one this plugin also serves,
 * so "compatible with dsh" is really "compatible with both release tuples" —
 * and the manifest must enumerate each tuple with `||` (a caret on a 0.x
 * prerelease never spans to the next minor).
 *
 * This gate reads the installed desktop runtime and fails when:
 *   1. the runtime version's tuple is not covered by a clause of
 *      `dsh.compatibility.dsh`, or has no exact `dshReleases` verdict;
 *   2. any `dsh.client.inject` package is absent from that runtime (a dead id
 *      is what silently prevented the client half from registering before).
 *
 * It reports SKIP when no desktop install is present (CI, other machines), so it
 * is safe to wire into `pnpm preflight` everywhere.
 *
 * Usage:  node scripts/check-desktop-compat.mjs [--asar <path>]
 * Exit:   0 PASS/SKIP, 1 FAIL
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const argv = process.argv.slice(2)
const asarIndex = argv.indexOf('--asar')
const asarArg = asarIndex === -1 ? null : argv[asarIndex + 1]

/** Candidate desktop bundle locations, most specific first. */
function candidateAsars() {
  const out = []
  if (asarArg) out.push(asarArg)
  if (process.env.DSH_DESKTOP_ASAR) out.push(process.env.DSH_DESKTOP_ASAR)
  out.push('D:/deepseekharness/resources/app.asar')
  const local = process.env.LOCALAPPDATA
  if (local) out.push(path.join(local, 'Programs', 'deepseek-harness', 'resources', 'app.asar'))
  const pf = process.env['ProgramFiles']
  if (pf) out.push(path.join(pf, 'DeepSeek Harness', 'resources', 'app.asar'))
  return out
}

/** Minimal ASAR reader: header JSON + offset-addressed file reads. */
function openAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  const prefix = Buffer.alloc(16)
  fs.readSync(fd, prefix, 0, 16, 0)
  const jsonSize = prefix.readUInt32LE(12)
  const headerBuf = Buffer.alloc(jsonSize)
  fs.readSync(fd, headerBuf, 0, jsonSize, 16)
  const header = JSON.parse(headerBuf.toString('utf8'))
  const baseOffset = 16 + jsonSize

  function find(relPath) {
    const parts = relPath.split('/').filter(Boolean)
    let node = header
    for (const part of parts) {
      const next = node.files?.[part]
      if (!next) return null
      node = next
    }
    return node.files ? null : { entry: node, relPath }
  }
  function read(hit) {
    if (!hit) return null
    if (hit.entry.unpacked) {
      const unpackedRoot = asarPath.replace(/app\.asar$/, 'app.asar.unpacked')
      return fs.readFileSync(path.join(unpackedRoot, hit.relPath), 'utf8')
    }
    const buf = Buffer.alloc(hit.entry.size)
    fs.readSync(fd, buf, 0, hit.entry.size, baseOffset + Number(hit.entry.offset))
    return buf.toString('utf8')
  }
  return { find, read, close: () => fs.closeSync(fd) }
}

function pkgVersion(asar, name) {
  for (const prefix of ['dsh/node_modules/', 'node_modules/']) {
    const hit = asar.find(`${prefix}${name}/package.json`)
    if (!hit) continue
    try {
      return JSON.parse(asar.read(hit)).version ?? null
    } catch {
      return null
    }
  }
  return null
}

/** Same coverage rule as tests/manifest-contract.test.ts. */
function tupleCovered(range, version) {
  const tuple = version.replace(/-.*$/, '')
  return range
    .split('||')
    .map((clause) => clause.trim().replace(/^[\^~]/, ''))
    .some((clause) => clause.startsWith(tuple))
}

// Reverse control: the coverage rule must reject a spanning range, otherwise a
// green run would prove nothing (the semver prerelease rule this gate exists for).
if (tupleCovered('>=0.1.5-rc.1 <0.2.0', '0.1.6-alpha.2') || !tupleCovered('^0.2.0-rc.2', '0.2.0-rc.2')) {
  console.error('P9 desktop compatibility: FAIL — coverage rule self-test regressed')
  process.exit(1)
}

const asarPath = candidateAsars().find((candidate) => candidate && fs.existsSync(candidate))
if (!asarPath) {
  console.log('P9 desktop compatibility: SKIP — no desktop install found (set DSH_DESKTOP_ASAR to check one)')
  process.exit(0)
}

const asar = openAsar(asarPath)
try {
  const runtimeEntry = asar.find('dsh/package.json')
  if (!runtimeEntry) {
    console.log(`P9 desktop compatibility: SKIP — ${asarPath} carries no dsh/ runtime`)
    process.exit(0)
  }
  const runtime = JSON.parse(asar.read(runtimeEntry))
  const range = manifest.dsh?.compatibility?.dsh ?? ''
  const releases = manifest.dsh?.compatibility?.dshReleases ?? {}
  const problems = []

  if (!tupleCovered(range, runtime.version)) {
    problems.push(
      `desktop runtime ${runtime.name}@${runtime.version} is not covered by dsh.compatibility.dsh "${range}"`,
    )
  }
  if (!(runtime.version in releases)) {
    problems.push(`no exact dshReleases verdict for "${runtime.version}"`)
  }
  for (const name of manifest.dsh?.client?.inject ?? []) {
    if (pkgVersion(asar, name) === null) problems.push(`dsh.client.inject "${name}" is absent from the desktop runtime`)
  }

  const hostVersions = ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-timeout', '@deepseek-ai/cordis']
    .map((name) => `${name}@${pkgVersion(asar, name) ?? 'not-found'}`)
    .join('  ')

  if (problems.length > 0) {
    console.error(`P9 desktop compatibility: FAIL — ${asarPath}`)
    for (const problem of problems) console.error(`    ${problem}`)
    process.exit(1)
  }
  console.log(
    `P9 desktop compatibility: PASS — ${runtime.name}@${runtime.version} accepted (range "${range}", ${Object.keys(releases).length} recorded releases)\n    ${hostVersions}`,
  )
} finally {
  asar.close()
}
