import { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * Source-level policy test for rule R2 (see docs/兼容性策略.md).
 *
 * Rule R2 — the client half may only read a service as `ctx.<name>` when that
 * name appears in its declared `inject` list. Everything optional goes through
 * `ctx.get('<name>')`, which returns the service or `undefined`.
 *
 * Why this rule exists, in one line of cordis: the context is a Proxy whose
 * `get` trap resolves `ctx.<name>` out of the fiber's *inject* store, and when
 * the name is not there it throws `cannot get property "<name>" without inject`
 * (`cordis/lib/index.js`, the `ReflectService.handler.get` trap). `apply()` is
 * not written to catch that, so ONE direct read of a service that is not
 * injected aborts the whole registration — which is exactly how 1.8.2 shipped:
 * the inject list was cut down to `['remote']` and `ctx.locale` on line 226 was
 * left behind, so every real machine lost both the ✨ button and the settings
 * page, with `failed to apply loader entry … cannot get property "locale"
 * without inject` in the console.
 *
 * The kernel set is *probed*, not hard-coded: `ctx.get` itself, `ctx.effect`,
 * `ctx.inject` and friends are core context members that resolve without any
 * inject declaration, and a frozen list of them would silently rot as cordis
 * evolves. `probeKernel()` mounts a throwaway plugin on a real `Context` and
 * records which names resolve on a context where nothing is provided — the
 * same "probe the capability, never the version" approach as
 * `src/compat/capability.ts`.
 *
 * `scripts/client-probe.mjs` enforces the same rule over the built
 * `lib/client.js`, so the artifact is covered even when tests are skipped.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = join(root, 'client', 'client.js')

interface DirectRead {
  readonly name: string
  /** 1-based line number in the original source, for actionable failures. */
  readonly line: number
}

/**
 * Blank out comments while preserving line numbers.
 *
 * Necessary, not cosmetic: the file documents the rule using the very syntax it
 * forbids (`never as \`ctx.locale\``, `every \`ctx.<name>\``), and counting
 * those as reads would make the check fail on its own documentation.
 */
function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
  return withoutBlocks
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//')
      if (index === -1) return line
      // Leave `https://…` alone; a colon immediately before the slashes.
      if (index > 0 && line[index - 1] === ':') return line
      return line.slice(0, index)
    })
    .join('\n')
}

/** Every `ctx.<name>` property read in executable code. */
function directContextReads(source: string): DirectRead[] {
  const reads: DirectRead[] = []
  stripComments(source)
    .split('\n')
    .forEach((line, index) => {
      for (const match of line.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
        reads.push({ name: match[1], line: index + 1 })
      }
    })
  return reads
}

/** Every string literal in a bracketed list, e.g. `'a', "b"`. */
function stringLiterals(list: string): string[] {
  return [...list.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1])
}

/**
 * The service names the client half declares via `exports.inject`.
 *
 * The file assigns the list by reference (`var inject = ['remote']` …
 * `exports.inject = inject`) rather than inlining the literal, so both shapes
 * are accepted. Returns `null` when no declaration can be found at all: that is
 * a scanner failure, not an empty list — treating "no `exports.inject`" as
 * "nothing is injected" would flag every read, and treating it as "everything
 * is injected" would flag none.
 */
function declaredInject(source: string): string[] | null {
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

/**
 * The rule itself, as a pure function, so the negative controls below exercise
 * the same code path the real assertion does.
 */
function violationsOf(source: string, kernel: ReadonlySet<string>): string[] {
  const declared = declaredInject(source)
  if (declared === null) {
    return ['could not parse the declared `exports.inject` list — every read would pass vacuously']
  }
  const injected = new Set(declared)
  return directContextReads(source)
    .filter((read) => !injected.has(read.name) && !kernel.has(read.name))
    .map(
      (read) =>
        `client.js:${read.line} reads ctx.${read.name}, which is neither injected nor a cordis core member`
        + ` — use ctx.get('${read.name}') or add it to \`inject\``,
    )
}

/**
 * Names that must resolve on a context with nothing provided, i.e. genuine
 * cordis core members, plus the service names this file must NOT find there.
 * Probing the negative names too is what makes the kernel set trustworthy: a
 * probe that answered "core" to everything would let every violation pass.
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

/** Which of `names` resolve on a real cordis context with no services provided. */
async function probeKernel(names: readonly string[]): Promise<Set<string>> {
  const kernel = new Set<string>()
  const root_ = new Context()
  await root_.plugin({
    name: 'client-inject-contract-kernel-probe',
    inject: [],
    apply(ctx) {
      for (const name of names) {
        try {
          void (ctx as unknown as Record<string, unknown>)[name]
          kernel.add(name)
        } catch {
          // Not a core member: exactly the case rule R2 is about.
        }
      }
    },
  })
  return kernel
}

const source = readFileSync(clientPath, 'utf8')

let kernel: ReadonlySet<string>
let reads: readonly DirectRead[]
let violations: readonly string[]

beforeAll(async () => {
  kernel = await probeKernel(PROBE_NAMES)
  reads = directContextReads(source)
  violations = violationsOf(source, kernel)
})

describe('client half inject contract (R2)', () => {
  it('probes a kernel set that is non-empty but excludes service names', () => {
    // Guards the guard: if the probe returned every name (or none), the rule
    // below would pass or fail regardless of what the source actually says.
    expect(kernel.size).toBeGreaterThan(0)
    expect([...kernel]).toContain('effect')
    expect([...kernel]).toContain('get')
    for (const service of ['locale', 'slots', 'remote', 'sessions', 'settingsScope']) {
      expect([...kernel]).not.toContain(service)
    }
  })

  it('scans a non-trivial number of direct reads, so the rule is exercised', () => {
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.map((read) => read.name)).toContain('remote')
    expect(reads.map((read) => read.name)).toContain('effect')
  })

  it('parses the declared inject list instead of assuming one', () => {
    const injected = declaredInject(source)
    expect(injected).not.toBeNull()
    expect(injected ?? []).toContain('remote')
    // The three optional services the 1.8.2 outage came from must stay OUT of
    // inject: listing them turns "one feature is missing" into "the whole
    // client half never loads".
    for (const optional of ['locale', 'sessions', 'settingsScope', 'slots']) {
      expect(injected ?? []).not.toContain(optional)
    }
  })

  it('never reads a service that is neither injected nor a cordis core member', () => {
    expect(violations).toEqual([])
  })

  it('flags a synthetic direct read of a non-injected service', () => {
    // The 1.8.2 bug, reduced to two lines. If this ever stops failing, the
    // assertion above has become vacuous.
    const broken = ['var inject = [\'remote\']', 'var locale = ctx.locale', 'exports.inject = inject'].join(
      '\n',
    )
    expect(violationsOf(broken, kernel)).toHaveLength(1)
    expect(violationsOf(broken, kernel)[0]).toContain('client.js:2 reads ctx.locale')
  })

  it('accepts the ctx.get() form of the same read', () => {
    const fixed = ["var inject = ['remote']", "var locale = ctx.get('locale')", 'exports.inject = inject'].join(
      '\n',
    )
    expect(violationsOf(fixed, kernel)).toEqual([])
  })

  it('ignores ctx.<name> written inside comments', () => {
    const commented = [
      "var inject = ['remote']",
      '// direct access like ctx.locale throws without inject; every ctx.<name> must be injected',
      "var locale = ctx.get('locale')",
      'exports.inject = inject',
    ].join('\n')
    expect(violationsOf(commented, kernel)).toEqual([])
  })

  it('reports a source it cannot parse rather than passing it', () => {
    expect(violationsOf('var locale = ctx.locale', kernel)).toEqual([
      'could not parse the declared `exports.inject` list — every read would pass vacuously',
    ])
  })
})
