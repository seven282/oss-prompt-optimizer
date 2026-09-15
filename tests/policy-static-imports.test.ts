import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Source-level policy test for rule R1 (see docs/兼容性策略.md).
 *
 * `src/**` may only statically import:
 *   (a) packages declared in this package's own `dependencies` — resolution is
 *       self-guaranteed, because we install them; and
 *   (b) `@deepseek-ai/cordis` — the framework the plugin is written against.
 *
 * Everything else must go through `src/compat/loader.ts`, which can fail
 * softly. The reason is not style: a static import of a host package resolves
 * during module instantiation and its failure is *uncatchable*, so one renamed
 * export (the 1.8.1 `deepFreeze` incident) takes the entire `dsh web` process
 * down. `scripts/preflight.mjs` enforces the same rule over the built `lib/`
 * artifacts; this test is the second lock, on the source.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src')

/** Every `.ts` file under `src/`. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, acc)
    else if (entry.isFile() && entry.name.endsWith('.ts')) acc.push(full)
  }
  return acc
}

/** A static import/export clause is erased when it is type-only. */
function isTypeOnlyClause(clause: string): boolean {
  const trimmed = clause.trim()
  if (trimmed.startsWith('type ')) return true
  const braced = /^\{([\s\S]*)\}$/.exec(trimmed)
  if (braced === null) return false
  const parts = braced[1].split(',').map((part) => part.trim()).filter((part) => part.length > 0)
  return parts.length > 0 && parts.every((part) => /^type\s+\S/.test(part))
}

interface StaticImport {
  readonly file: string
  readonly specifier: string
  readonly typeOnly: boolean
  /** `import '…'` with no clause — runs the module for its side effects only. */
  readonly sideEffect: boolean
  /**
   * Written as a top-level `import type …`, which TypeScript erases *entirely*.
   *
   * The inline `import { type X } from 'pkg'` form is NOT equivalent: under
   * `verbatimModuleSyntax` it is emitted as `import {} from 'pkg'`, which is
   * still a runtime import and still resolves the host module during
   * instantiation — i.e. it silently reintroduces the 1.8.1 failure mode while
   * looking type-only in the source. This flag is what lets the policy test
   * tell the two apart.
   */
  readonly erased: boolean
}

/** Collect every top-level `import … from` / `export … from` / `import '…'`. */
function collectStaticImports(file: string): StaticImport[] {
  const source = readFileSync(file, 'utf8')
  const found: StaticImport[] = []
  const patterns: { pattern: RegExp; sideEffect: boolean }[] = [
    { pattern: /^[ \t]*import\b([^;]*?)\bfrom\s*['"]([^'"]+)['"]/gm, sideEffect: false },
    { pattern: /^[ \t]*export\b([^;]*?)\bfrom\s*['"]([^'"]+)['"]/gm, sideEffect: false },
    { pattern: /^[ \t]*import\s*['"]([^'"]+)['"]/gm, sideEffect: true },
  ]
  for (const { pattern, sideEffect } of patterns) {
    for (const match of source.matchAll(pattern)) {
      const clause = sideEffect ? '' : match[1]
      const specifier = sideEffect ? match[1] : match[2]
      found.push({
        file: relative(root, file),
        specifier,
        typeOnly: !sideEffect && isTypeOnlyClause(clause),
        sideEffect,
        erased: !sideEffect && clause.trim().startsWith('type '),
      })
    }
  }
  return found
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
}

const STATIC_ALLOWLIST = new Set<string>([
  '@deepseek-ai/cordis',
  ...Object.keys(manifest.dependencies ?? {}),
])

const allImports = sourceFiles(srcDir).flatMap(collectStaticImports)
const runtimeBareImports = allImports.filter(
  (entry) => !entry.typeOnly
    && !entry.specifier.startsWith('.')
    && !entry.specifier.startsWith('node:'),
)

describe('static import policy (R1)', () => {
  it('scans a non-trivial number of imports, so the policy is actually exercised', () => {
    expect(allImports.length).toBeGreaterThan(30)
  })

  it('only statically imports the framework and self-installed dependencies', () => {
    const violations = runtimeBareImports
      .filter((entry) => !STATIC_ALLOWLIST.has(entry.specifier))
      .map((entry) => `${entry.file}: ${entry.specifier}`)
    expect(violations).toEqual([])
  })

  it('never statically imports a harness domain package at runtime', () => {
    // These are the four the plugin used to depend on directly. They must be
    // reached through the compat loader only.
    const forbidden = [
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-timeout',
      '@deepseek-ai/dsh-commands',
      '@deepseek-ai/dsh-util-values',
      '@deepseek-ai/dsh-system-prompt',
    ]
    const offenders = runtimeBareImports
      .filter((entry) => forbidden.includes(entry.specifier))
      .map((entry) => `${entry.file}: ${entry.specifier}`)
    expect(offenders).toEqual([])
  })

  it('still allows type-only imports from host packages (erased at compile time)', () => {
    const typeOnlyBare = allImports.filter((entry) => entry.typeOnly && !entry.specifier.startsWith('.'))
    expect(typeOnlyBare.map((entry) => entry.specifier)).toContain('@deepseek-ai/dsh-llm')
  })

  it('contains no side-effect-only host import', () => {
    // A bare `import '@deepseek-ai/dsh-x'` has no clause, hence is never
    // type-only, hence would slip past every check above (`typeOnly` is false,
    // so it is not in the type-only allowlist, and its *runtime* bare specifier
    // is not in STATIC_ALLOWLIST either — but it deserves its own explicit
    // guard, because the failure it causes is exactly the 1.8.1 one: the host
    // module is fetched during instantiation and cannot be caught.
    const offenders = allImports
      .filter((entry) => entry.sideEffect)
      .filter((entry) => entry.specifier.startsWith('@deepseek-ai/dsh'))
      .map((entry) => `${entry.file}: ${entry.specifier}`)
    expect(offenders).toEqual([])
  })

  it('actually distinguishes side-effect imports, so the guard is not vacuous', () => {
    // Guards the guard: `sideEffect` has to be populated, otherwise the check
    // above passes no matter what the source says.
    const sample = allImports.filter((entry) => entry.sideEffect)
    expect(sample.every((entry) => entry.typeOnly === false)).toBe(true)
    expect(allImports.some((entry) => entry.sideEffect === false)).toBe(true)
  })

  it('writes host-package type imports in the fully-erased form', () => {
    // The trap this catches: `import { type X } from '@deepseek-ai/dsh-llm'`
    // looks type-only and passes every other check here, but
    // `verbatimModuleSyntax` emits it as `import {} from '@deepseek-ai/dsh-llm'`
    // — a live runtime import that drags the host module in at instantiation.
    // Only `import type { X } from …` is guaranteed to vanish.
    const offenders = allImports
      .filter((entry) => entry.typeOnly && !entry.erased)
      .filter((entry) => entry.specifier.startsWith('@deepseek-ai/dsh'))
      .map((entry) => `${entry.file}: ${entry.specifier} — use \`import type { … }\``)
    expect(offenders).toEqual([])
  })

  it('records the erased-form flag for both shapes, so the check above bites', () => {
    // Guards the guard again: if `erased` were always true the check passes
    // vacuously; if it were always false every `import type` would be flagged.
    expect(allImports.some((entry) => entry.erased)).toBe(true)
    expect(allImports.some((entry) => entry.typeOnly && !entry.erased)).toBe(true)
  })

  it('keeps the loader as the single entry point for host packages', () => {
    const loader = readFileSync(join(srcDir, 'compat', 'loader.ts'), 'utf8')
    expect(loader).toContain('createRequire')
    // The loader itself must not import any host package.
    const loaderImports = collectStaticImports(join(srcDir, 'compat', 'loader.ts'))
    expect(loaderImports.map((entry) => entry.specifier)).toEqual(['node:module'])
  })
})
