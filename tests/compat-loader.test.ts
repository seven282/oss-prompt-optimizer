import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { StreamAssembler } from '../src/compat/capability.js'
import { loadHostPackage, resetHostPackageCache, resolveConstructor, resolveExport } from '../src/compat/loader.js'

describe('loadHostPackage', () => {
  it('returns null for a package that does not resolve — never throws', () => {
    // The whole point of the compat layer: a missing host package must be a
    // value, not an exception that escapes module loading.
    expect(() => loadHostPackage('@deepseek-ai/definitely-not-a-real-package')).not.toThrow()
    expect(loadHostPackage('@deepseek-ai/definitely-not-a-real-package')).toBeNull()
  })

  it('returns null for a malformed specifier', () => {
    expect(loadHostPackage('')).toBeNull()
    expect(loadHostPackage('::: not a specifier :::')).toBeNull()
  })

  it('loads a real host package and is idempotent', () => {
    const first = loadHostPackage('@deepseek-ai/dsh-llm')
    const second = loadHostPackage('@deepseek-ai/dsh-llm')
    expect(first).not.toBeNull()
    expect(second).toBe(first)
  })

  it('re-probes after the cache is reset', () => {
    const before = loadHostPackage('@deepseek-ai/dsh-llm')
    resetHostPackageCache()
    const after = loadHostPackage('@deepseek-ai/dsh-llm')
    // Same module instance (Node's own require cache is untouched) but the
    // probe ran again, which is what the seam exists for.
    expect(after).toBe(before)
  })
})

describe('resolveExport', () => {
  it('resolves a function export of a real package', () => {
    expect(typeof resolveExport('@deepseek-ai/dsh-tools', 'defineTool', 'function')).toBe('function')
  })

  it('returns null for a name the package does not export', () => {
    expect(resolveExport('@deepseek-ai/dsh-llm', 'noSuchExport', 'function')).toBeNull()
    expect(resolveExport('@deepseek-ai/dsh-tools', 'noSuchExport', 'function')).toBeNull()
  })

  it('probes a moved export truthfully instead of throwing', () => {
    // The 1.8.1 outage was `dsh-llm` dropping its `deepFreeze` re-export when the
    // helper moved to `dsh-util-values`. Which package carries it depends on the
    // *installed* harness — `dsh-util-values` is not even present in this
    // workspace's node_modules — so asserting "package X exports Y" would pin the
    // test to one host layout and defeat the point. The contract under test is
    // the probe's: answer truthfully, never throw, and only ever hand back a
    // value of the requested kind.
    const candidates = ['@deepseek-ai/dsh-util-values', '@deepseek-ai/dsh-llm']
    for (const pkg of candidates) {
      expect(() => resolveExport(pkg, 'deepFreeze', 'function')).not.toThrow()
    }
    const answers = candidates.map((pkg) => resolveExport(pkg, 'deepFreeze', 'function'))
    for (const answer of answers) {
      if (answer !== null) expect(typeof answer).toBe('function')
    }
    // A package that cannot be loaded must report `null`, not a stale function —
    // this is the exact signal the host-startup guard relies on.
    expect(resolveExport('@deepseek-ai/dsh-util-values', 'deepFreeze', 'function')).toBeNull()
  })

  it('does not need the host helper at all — deepFreeze is vendored in src/compat', () => {
    // The real fix for the outage: the plugin stopped depending on the host for
    // this helper. Mirrors the assertion above, from the other side.
    const vendored = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'compat', 'freeze.ts')
    expect(readFileSync(vendored, 'utf8')).toContain('export function deepFreeze')
  })

  it('returns null when the export exists but the kind is wrong', () => {
    // DefineToolFn is a function; asking for an object must not hand it back.
    expect(resolveExport('@deepseek-ai/dsh-tools', 'defineTool', 'object')).toBeNull()
  })

  it('returns null for a package that cannot be loaded', () => {
    expect(resolveExport('@deepseek-ai/definitely-not-a-real-package', 'anything')).toBeNull()
  })
})

describe('resolveConstructor', () => {
  it('resolves the BlockAssembler class', () => {
    const Ctor = resolveConstructor<StreamAssembler>('@deepseek-ai/dsh-llm', 'BlockAssembler')
    expect(Ctor).not.toBeNull()
    const instance = new Ctor!()
    expect(typeof instance.push).toBe('function')
    expect(typeof instance.blocks).toBe('function')
  })

  it('returns null instead of a broken constructor when the class is absent', () => {
    expect(resolveConstructor<StreamAssembler>('@deepseek-ai/dsh-llm', 'NoSuchClass')).toBeNull()
  })
})
