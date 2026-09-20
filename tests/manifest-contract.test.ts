import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Manifest-contract test — the fields DSH STORE reads before it will list or
 * update a plugin, checked at the source level so a packaging mistake fails in
 * `pnpm test` instead of surfacing as an opaque marketplace finding.
 *
 * Background (issue #901): 1.8.4 was deferred with
 *
 *   runtime artifact is missing from the fixed Git Commit: lib/index.js;
 *   ./lib/types/index.d.ts; ./lib/client.js
 *
 * `lib/` was gitignored, so the pin-able commit contained only `src/` — while
 * `npm publish` looked perfectly healthy, because npm rebuilds through
 * `prepublishOnly` and honours `files`. The store never runs install, prepare
 * or build, so a fixed commit must carry its own runtime files.
 *
 * The same report withheld the listing because the manifest declared no
 * `dsh.compatibility.dshReleases` record at all, and a range alone does not
 * count as installable evidence.
 *
 * What this file locks down:
 *   1. every runtime path the manifest publishes is on disk, is *not* ignored by
 *      git, and is covered by `files` (so it survives into the tarball);
 *   2. Node and DSH ranges are declared, and each `dshReleases` key is an exact
 *      version whose [major.minor.patch] appears in the range — the semver
 *      prerelease rule that makes `>=0.1.5-rc.1 <0.2.0` silently fail to match
 *      `0.1.6-alpha.2`;
 *   3. the bundle patch stays additive and plugin-owned: exactly one inserted
 *      entry, whose id is not part of the protected `@deepseek-ai` namespace.
 *
 * `scripts/preflight.mjs` P8 re-checks the on-disk/git half against the built
 * tree; this test is the one that runs in CI's plain `pnpm test`.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string
  version: string
  license?: string
  main?: string
  types?: string
  files?: string[]
  exports?: Record<string, string | Record<string, string>>
  engines?: Record<string, string>
  scripts?: Record<string, string>
  dsh?: {
    bundle?: { patch?: string }
    client?: { inject?: string[]; platform?: string }
    compatibility?: { dsh?: string; dshReleases?: Record<string, string> }
  }
}

/**
 * Every path the manifest promises a consumer, flattened and de-duplicated.
 * `package.json` is dropped: it is always packed, whatever `files` says.
 */
function declaredRuntimePaths(): string[] {
  const found: string[] = []
  const push = (value: unknown): void => {
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
    else for (const value of Object.values(entry)) push(value)
  }
  return found
}

/** True when the given relative path is matched by the `files` allowlist. */
function coveredByFiles(path: string): boolean {
  return (manifest.files ?? []).some((entry) => {
    const normalized = entry.replace(/^\.\//, '').replace(/\/$/, '')
    return path === normalized || path.startsWith(`${normalized}/`)
  })
}

const RUNTIME_PATHS = declaredRuntimePaths()
const TERMINALS = new Set(['compatible', 'incompatible', 'unknown'])

describe('manifest contract — runtime artifacts survive into a fixed commit', () => {
  it('declares at least one runtime path', () => {
    expect(RUNTIME_PATHS.length).toBeGreaterThan(0)
  })

  it('has every declared runtime path on disk', () => {
    const missing = RUNTIME_PATHS.filter((path) => !existsSync(join(root, path)))
    expect(missing).toEqual([])
  })

  it('reverse control — the on-disk probe can report a missing file', () => {
    // Without this, a typo'd path list could make the check above vacuous.
    expect(existsSync(join(root, 'lib', 'definitely-not-a-real-file.js'))).toBe(false)
  })

  it('covers every declared runtime path with the files allowlist', () => {
    const uncovered = RUNTIME_PATHS.filter((path) => !coveredByFiles(path))
    expect(uncovered).toEqual([])
  })

  it('keeps the published bundle out of .gitignore', () => {
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
    const ignored = RUNTIME_PATHS.filter((path) => ignore.some((rule) => path.startsWith(rule.replace(/\/$/, ''))))
    expect(ignored).toEqual([])
  })

  it('builds through prepublishOnly, not prepare', () => {
    // `prepare` also runs for git dependencies, which forces every consumer's
    // package manager to execute our build script (pnpm 11+ blocks that by
    // default). The bundle is committed, so only publishing needs a build.
    expect(manifest.scripts?.prepublishOnly).toBeTruthy()
    expect(manifest.scripts?.prepare).toBeUndefined()
  })
})

describe('manifest contract — DSH STORE compatibility declarations', () => {
  it('declares a Node.js range', () => {
    expect(manifest.engines?.node).toMatch(/^>=?\s*\d+/)
  })

  it('declares the same DSH range in engines and in dsh.compatibility', () => {
    const enginesRange = manifest.engines?.dsh
    const compatRange = manifest.dsh?.compatibility?.dsh
    expect(enginesRange).toBeTruthy()
    expect(compatRange).toBe(enginesRange)
  })

  it('records at least one exact dshReleases verdict', () => {
    const releases = manifest.dsh?.compatibility?.dshReleases ?? {}
    expect(Object.keys(releases).length).toBeGreaterThan(0)
  })

  it('uses exact version keys with a legal terminal for each', () => {
    const releases = manifest.dsh?.compatibility?.dshReleases ?? {}
    for (const [version, verdict] of Object.entries(releases)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
      expect(TERMINALS.has(verdict)).toBe(true)
    }
  })

  it('covers each recorded release by a same-tuple clause in the DSH range', () => {
    // The semver prerelease rule: 0.1.6-alpha.2 only satisfies a range when some
    // comparator in it carries the *same* [major.minor.patch] plus a prerelease.
    // `>=0.1.5-rc.1 <0.2.0` therefore does NOT match it, which is why the range
    // enumerates tuples with `||` instead of spanning them.
    const range = manifest.dsh?.compatibility?.dsh ?? ''
    const clauses = range.split('||').map((clause) => clause.trim()).filter(Boolean)
    const releases = Object.keys(manifest.dsh?.compatibility?.dshReleases ?? {})
    for (const version of releases) {
      const [major, minor, patch] = version.replace(/-.*$/, '').split('.')
      const tuple = `${major}.${minor}.${patch}`
      const covered = clauses.some((clause) => clause.replace(/^[\^~]/, '').startsWith(tuple))
      expect(covered, `${version} is not covered by any clause of "${range}"`).toBe(true)
    }
  })

  it('reverse control — the tuple rule rejects a range that cannot match', () => {
    const version = '0.1.6-alpha.2'
    const wrongRange = '>=0.1.5-rc.1 <0.2.0'
    const [major, minor, patch] = version.replace(/-.*$/, '').split('.')
    const tuple = `${major}.${minor}.${patch}`
    const covered = wrongRange.split('||').some((clause) => clause.trim().replace(/^[\^~]/, '').startsWith(tuple))
    expect(covered).toBe(false)
  })
})

describe('manifest contract — bundle patch stays additive and plugin-owned', () => {
  const patchPath = manifest.dsh?.bundle?.patch

  it('points at a patch file that exists', () => {
    expect(patchPath).toBeTruthy()
    expect(existsSync(join(root, patchPath as string))).toBe(true)
  })

  it('inserts exactly one entry, and it is ours', () => {
    const patch = readFileSync(join(root, patchPath as string), 'utf8')
    const ids = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map((m) => m[1])
    expect(ids.length).toBe(1)
    expect(ids[0].startsWith('@deepseek-ai/')).toBe(false)
  })

  it('never claims the protected @deepseek-ai namespace', () => {
    expect(manifest.name.startsWith('@deepseek-ai/')).toBe(false)
  })

  it('declares the client half with a platform and a non-empty inject list', () => {
    expect(manifest.dsh?.client?.platform).toBe('web')
    const inject = manifest.dsh?.client?.inject ?? []
    expect(inject.length).toBeGreaterThan(0)
    expect(inject.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
  })
})
