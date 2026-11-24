#!/usr/bin/env node
/**
 * P9 — desktop/web dual compatibility check.
 *
 * The desktop app ships its own harness runtime inside an Electron `app.asar`
 * (`@deepseek-ai/dsh-desktop-runtime`), a different release line from the CLI/web
 * one this plugin also serves — so the manifest must enumerate BOTH tuples with
 * `||` (a caret never spans 0.x prereleases).
 * Fails when the installed runtime's tuple is not covered by
 * `dsh.compatibility.dsh`, has no exact `dshReleases` verdict, or is missing any
 * package named in `dsh.client.inject` (a dead id silently kept the client half
 * from registering before).
 *
 * Usage: node scripts/check-desktop-compat.mjs [--asar <path>] → 0 PASS/SKIP, 1 FAIL;
 * SKIPs when no desktop install is present (CI), so it is safe in `pnpm preflight`.
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
  function read(hit, extraBytes = 0) {
    if (!hit) return null
    if (hit.entry.unpacked) {
      const unpackedRoot = asarPath.replace(/app\.asar$/, 'app.asar.unpacked')
      return fs.readFileSync(path.join(unpackedRoot, hit.relPath), 'utf8')
    }
    const size = hit.entry.size + extraBytes
    const buf = Buffer.alloc(size)
    const got = fs.readSync(fd, buf, 0, size, baseOffset + Number(hit.entry.offset))
    return buf.toString('utf8', 0, got)
  }
  const suffixCache = new Map()
  /**
   * Last-resort lookup: find any `…/node_modules/<name>/package.json` in the
   * header. pnpm layouts nest the real directory under
   * `.pnpm/<id>/node_modules/`, so trusting one hard-coded prefix turns a layout
   * change into a false "package absent". Built once per suffix, then cached.
   */
  function searchSuffix(suffix) {
    if (suffixCache.has(suffix)) return suffixCache.get(suffix)
    let best = null
    const walk = (node, prefixPath) => {
      for (const [key, child] of Object.entries(node.files ?? {})) {
        const rel = prefixPath ? `${prefixPath}/${key}` : key
        if (child.files) walk(child, rel)
        else if (rel.endsWith(suffix) && (!best || rel.length < best.relPath.length)) best = { entry: child, relPath: rel }
      }
    }
    walk(header, '')
    suffixCache.set(suffix, best)
    return best
  }
  return { find, searchSuffix, read, close: () => fs.closeSync(fd) }
}

/**
 * Parse a package.json that may carry stray bytes from the neighbouring files
 * glued to either end. Some desktop bundles record an offset a few bytes short
 * of the real payload, so a read starts with the tail of the previous file
 * (`\n}\n`, `};\n`) and ends with the head of the next (`impor`, `/** P`). The
 * JSON object itself is intact — locate its first `{` and read to the matching
 * `}` (string-aware) instead of feeding the whole buffer to `JSON.parse`.
 * A clean payload still takes the fast path unchanged.
 */
function parsePackageJson(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    /* fall through to the offset-tolerant path */
  }
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/**
 * Version of `name` inside the bundle, or `null` when it is genuinely absent.
 *
 * Desktop builds from 0.2.1 on record an entry `size` a few bytes short of the
 * real payload: an exact-size read can drop the closing brace, and `JSON.parse`
 * throws on the glued prefix/suffix. Only a *missing entry* means absent; an
 * entry we cannot read at any width is reported as 'unreadable' instead.
 */
function pkgVersion(asar, name) {
  const hit =
    asar.find(`dsh/node_modules/${name}/package.json`) ??
    asar.find(`node_modules/${name}/package.json`) ??
    asar.searchSuffix(`node_modules/${name}/package.json`)
  if (!hit) return null
  for (const extraBytes of [0, 1, 2, 8]) {
    const parsed = parsePackageJson(asar.read(hit, extraBytes))
    if (parsed?.version) return parsed.version
  }
  return 'unreadable'
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
  let runtime = null
  for (const extraBytes of [0, 1, 2, 8]) {
    runtime = parsePackageJson(asar.read(runtimeEntry, extraBytes))
    if (runtime?.version) break
  }
  if (!runtime?.version) {
    console.error(`P9 desktop compatibility: FAIL — dsh/package.json in ${asarPath} cannot be parsed`)
    process.exit(1)
  }
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
    const version = pkgVersion(asar, name)
    if (version === null) problems.push(`dsh.client.inject "${name}" is absent from the desktop runtime`)
    // Present but unparseable is not "fine": silently accepting it is how the
    // three phantom `absent` reports of 1.13.1 went unnoticed for a release.
    else if (version === 'unreadable') problems.push(`dsh.client.inject "${name}" is present but its package.json cannot be parsed`)
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
