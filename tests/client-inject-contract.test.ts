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
 * Rule R2b — a service whose name contains a dot is a *separate service*, and
 * it must never be reached by reading a property off its parent. 1.8.3 fixed
 * R2 and broke R2b: `ctx.get('remote').commands` on line 252. The value of
 * `ctx.get('remote')` is a cordis `Service`, and when a service with the dotted
 * name `remote.commands` is itself registered — dsh-api-gateway mounts every
 * remote namespace that way, `remoteServiceKey(ns) === 'remote.' + ns` — the
 * traceable proxy behind the service *rewrites* the read of `.commands` into a
 * read of `ctx['remote.commands']` (`cordis/lib/index.js`, `createTraceable`,
 * the `tracker.associate` branch), which is gated again. So it throws
 * `cannot get property "remote.commands" without inject`, and
 * `ctx.get('<dotted name>')` is the only safe way in.
 *
 * `NAMESPACE_ROOTS` below is the set of services whose children are registered
 * as separate dotted services, i.e. the services for which a property read can
 * be hijacked. It is deliberately narrow, because the condition is not "is the
 * parent a Service" but "is `<parent>.<child>` a registered service name".
 * Measured against the installed dsh (`0.1.5-rc.2`):
 *
 * - every dotted service name in dsh — 18 of them — starts with `remote.`
 * - all 86 literal names passed to `super(ctx, '<name>')` across dsh packages
 *   are dot-free
 * - the only code that builds a dotted name is `remoteServiceKey()`
 *
 * so `slots`, `locale`, `sessions` and `settingsScope` cannot be hijacked and
 * must NOT be flagged here (reading `slots.inject` is a plain property read —
 * over-reaching would make this test cry wolf and get weakened). When dsh grows
 * a new namespace root, this list is what has to be updated;
 * `scripts/client-probe.mjs` re-derives the roots from the local dsh install and
 * fails loudly when they disagree, so the list cannot silently rot.
 *
 * The kernel set is *probed*, not hard-coded: `ctx.get` itself, `ctx.effect`,
 * `ctx.inject` and friends are core context members that resolve without any
 * inject declaration, and a frozen list of them would silently rot as cordis
 * evolves. `probeKernel()` mounts a throwaway plugin on a real `Context` and
 * records which names resolve on a context where nothing is provided — the
 * same "probe the capability, never the version" approach as
 * `src/compat/capability.ts`.
 *
 * `scripts/client-probe.mjs` enforces the same rules over the built
 * `lib/client.js`, so the artifact is covered even when tests are skipped.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = join(root, 'client', 'client.js')

/** Services whose `<name>.<child>` are registered as separate dotted services. */
const NAMESPACE_ROOTS = ['remote'] as const

const UNPARSEABLE =
  'could not parse the declared `exports.inject` list — every read would pass vacuously'

interface ServiceRead {
  /** The service name the read resolves to, e.g. `remote` or `remote.commands`. */
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

/**
 * Every service read written as `ctx.<name>` … `ctx.<name>.<child>`.
 *
 * The dotted form is reported as exactly two segments — `ctx.remote.commands.execute`
 * is a read of the service `remote.commands` whose value is then called, so the
 * actionable name is `remote.commands`. Truncating at the first dot instead
 * would report `remote`, which is legitimately injected and therefore invisible
 * to rule R2.
 *
 * Bracket access is captured too, because it reaches the same `get` trap:
 * `ctx['remote.commands']` is gated exactly like `ctx.remote.commands`.
 */
function contextReads(source: string): ServiceRead[] {
  const reads: ServiceRead[] = []
  stripComments(source)
    .split('\n')
    .forEach((line, index) => {
      for (const match of line.matchAll(
        /\bctx\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g,
      )) {
        reads.push({ name: match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`, line: index + 1 })
      }
      for (const match of line.matchAll(/\bctx\[\s*['"]([^'"]+)['"]\s*\]/g)) {
        reads.push({ name: match[1], line: index + 1 })
      }
    })
  return reads
}

/**
 * Reads of a *nested* service name reached through its parent: the shape rule
 * R2b exists for.
 *
 * `ctx.get('remote')` on its own is a legitimate read. Taking a property off
 * the result is not — and the alias form hides that across two lines, where the
 * legal read is on one line and the offending one on another, invisible to a
 * scanner that only looks for `ctx.<name>`. Only aliases of namespace roots are
 * expanded: expanding every service alias would flag `slots.inject()` and
 * `locale.bind()`, which are ordinary method reads on plain services.
 */
function nestedReads(source: string): ServiceRead[] {
  const clean = stripComments(source)
  const roots = NAMESPACE_ROOTS as readonly string[]
  const reads: ServiceRead[] = []

  /** A call target followed by `.prop` or `['prop']`, all in one match. */
  const chained = (target: string): RegExp =>
    new RegExp(
      `\\b${target}\\s*(?:\\.([A-Za-z_$][\\w$]*)|\\[\\s*['"]([^'"]+)['"]\\s*\\])`,
      'g',
    )

  const inline = chained("ctx\\.get\\(\\s*['\"]([^'\"]+)['\"]\\s*\\)")
  clean.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(inline)) {
      reads.push({ name: `${match[1]}.${match[2] ?? match[3]}`, line: index + 1 })
    }
  })

  const aliases: { local: string; service: string }[] = []
  for (const match of clean.matchAll(
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*ctx\.get\(\s*['"]([^'"]+)['"]\s*\)/g,
  )) {
    aliases.push({ local: match[1], service: match[2] })
  }
  for (const match of clean.matchAll(
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*ctx\.([A-Za-z_$][\w$]*)/g,
  )) {
    aliases.push({ local: match[1], service: match[2] })
  }
  for (const alias of aliases) {
    if (!roots.includes(alias.service)) continue
    const read = chained(alias.local)
    clean.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(read)) {
        reads.push({ name: `${alias.service}.${match[1] ?? match[2]}`, line: index + 1 })
      }
    })
  }

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
  if (declared === null) return [UNPARSEABLE]
  const injected = new Set(declared)
  const violations: string[] = []

  const isRooted = (name: string): boolean =>
    (NAMESPACE_ROOTS as readonly string[]).includes(name.split('.')[0])

  for (const read of [...contextReads(source), ...nestedReads(source)]) {
    // Dotted reads are only dangerous under a namespace root; everywhere else a
    // property read off a service is an ordinary read and flagging it would be
    // noise (`ctx.reflect.props`, `slots.inject`).
    if (read.name.includes('.') && !isRooted(read.name)) continue
    if (injected.has(read.name) || kernel.has(read.name)) continue
    violations.push(
      read.name.includes('.')
        ? `client.js:${read.line} reads the nested service "${read.name}" as a property of its parent`
          + ` — read it as ctx.get('${read.name}'), and keep it out of \`inject\` so a namespace that`
          + ' is not mounted yet costs a feature instead of the whole client half'
        : `client.js:${read.line} reads ctx.${read.name}, which is neither injected nor a cordis core member`
          + ` — use ctx.get('${read.name}') or add it to \`inject\``,
    )
  }

  for (const name of injected) {
    if (!name.includes('.')) continue
    violations.push(
      `\`inject\` lists the nested service "${name}" — a namespaced service may legitimately not be`
        + ' mounted yet, so listing it turns a missing namespace into "the client half never loads"',
    )
  }

  // A line can read the same service twice; report each finding once.
  return [...new Set(violations)]
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
  'remote.commands',
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
          // Not a core member: exactly the case rules R2/R2b are about.
        }
      }
    },
  })
  return kernel
}

const source = readFileSync(clientPath, 'utf8')

let kernel: ReadonlySet<string>
let reads: readonly ServiceRead[]
let violations: readonly string[]

beforeAll(async () => {
  kernel = await probeKernel(PROBE_NAMES)
  reads = [...contextReads(source), ...nestedReads(source)]
  violations = violationsOf(source, kernel)
})

describe('client half inject contract (R2 / R2b)', () => {
  it('probes a kernel set that is non-empty but excludes service names', () => {
    // Guards the guard: if the probe returned every name (or none), the rule
    // below would pass or fail regardless of what the source actually says.
    expect(kernel.size).toBeGreaterThan(0)
    expect([...kernel]).toContain('effect')
    expect([...kernel]).toContain('get')
    for (const service of ['locale', 'slots', 'remote', 'remote.commands', 'sessions', 'settingsScope']) {
      expect([...kernel]).not.toContain(service)
    }
  })

  it('scans a non-trivial number of service reads, so the rule is exercised', () => {
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.map((read) => read.name)).toContain('effect')
    expect(reads.map((read) => read.name)).toContain('get')
    // The real source is expected to contain no nested read at all, so the
    // scanners' ability to see the shapes one can take is asserted on synthetic
    // samples instead: a scanner that silently truncated at the first dot would
    // make the 1.8.3 assertion below unreachable.
    expect(contextReads('ctx.remote.commands').map((read) => read.name)).toEqual(['remote.commands'])
    expect(contextReads("ctx['remote.commands']").map((read) => read.name)).toEqual(['remote.commands'])
    expect(nestedReads("var channel = ctx.get('remote').commands").map((read) => read.name)).toEqual([
      'remote.commands',
    ])
    expect(nestedReads("ctx.get('remote')['commands']").map((read) => read.name)).toEqual([
      'remote.commands',
    ])
    expect(
      nestedReads("var remote = ctx.get('remote')\nvar channel = remote.commands").map(
        (read) => read.name,
      ),
    ).toEqual(['remote.commands'])
  })

  it('parses the declared inject list instead of assuming one', () => {
    const injected = declaredInject(source)
    expect(injected).not.toBeNull()
    expect(injected ?? []).toContain('remote')
    // The optional services the outages came from must stay OUT of inject:
    // listing one turns "one feature is missing" into "the whole client half
    // never loads". A nested name is optional by the same argument — the
    // namespace may not be mounted at apply() time.
    for (const optional of ['locale', 'sessions', 'settingsScope', 'slots', 'remote.commands']) {
      expect(injected ?? []).not.toContain(optional)
    }
  })

  it('never reads a service that is neither injected nor a cordis core member', () => {
    expect(violations).toEqual([])
  })

  it('flags a synthetic direct read of a non-injected service (1.8.2 regression)', () => {
    // The 1.8.2 bug, reduced to two lines. If this ever stops failing, the
    // assertion above has become vacuous.
    const broken = ['var inject = [\'remote\']', 'var locale = ctx.locale', 'exports.inject = inject'].join(
      '\n',
    )
    expect(violationsOf(broken, kernel)).toHaveLength(1)
    expect(violationsOf(broken, kernel)[0]).toContain('client.js:2 reads ctx.locale')
  })

  it('flags a dotted read of a nested service (1.8.3 regression)', () => {
    // Line 252 of 1.8.3, which took the ✨ button and the settings page down
    // again after R2 had been fixed.
    const broken = [
      "var inject = ['remote']",
      'var commandChannel = ctx.get(\'remote\').commands',
      'exports.inject = inject',
    ].join('\n')
    const found = violationsOf(broken, kernel)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('client.js:2 reads the nested service "remote.commands"')
    expect(found[0]).toContain("ctx.get('remote.commands')")
  })

  it('flags the same violation written straight off ctx', () => {
    // The other half of the same 1.8.3 line — the fallback branch nobody ever
    // reached, which is exactly why it survived review.
    const broken = ["var inject = ['remote']", 'var channel = ctx.remote.commands', 'exports.inject = inject'].join(
      '\n',
    )
    const found = violationsOf(broken, kernel)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('client.js:2 reads the nested service "remote.commands"')
  })

  it('flags the same violation when the service is stashed in a local first', () => {
    // The shape that made the alias scanner necessary: the `ctx.` read on line
    // 1 is legal, and the violation is invisible to a scanner that only looks
    // for `ctx.<name>`.
    const broken = [
      "var inject = ['remote']",
      "var remote = ctx.get('remote')",
      "var channel = remote.commands",
      'exports.inject = inject',
    ].join('\n')
    const found = violationsOf(broken, kernel)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('client.js:3 reads the nested service "remote.commands"')
  })

  it('flags a nested service listed in inject', () => {
    const broken = ["var inject = ['remote', 'remote.commands']", 'exports.inject = inject'].join('\n')
    const found = violationsOf(broken, kernel)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('`inject` lists the nested service "remote.commands"')
  })

  it('does not flag ordinary method reads on services that are not namespace roots', () => {
    // Guards against over-reach. `slots` and `locale` are plain services: dsh
    // registers no `slots.*` or `locale.*` service names, so these are ordinary
    // property reads. A rule that flagged them would be weakened until it
    // caught nothing.
    const fine = [
      "var inject = ['remote']",
      "var slots = ctx.get('slots')",
      "slots.inject('conversation.input.left', function () {})",
      "var locale = ctx.get('locale')",
      'locale.bind(NS)',
      "var channel = ctx.get('remote.commands')",
      'channel.execute(sessionId, line, args, signal)',
      'exports.inject = inject',
    ].join('\n')
    expect(violationsOf(fine, kernel)).toEqual([])
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
      '// direct access like ctx.locale throws without inject; every ctx.<name> must be injected,',
      '// and ctx.remote.commands is a nested service name that must go through ctx.get()',
      "var locale = ctx.get('locale')",
      'exports.inject = inject',
    ].join('\n')
    expect(violationsOf(commented, kernel)).toEqual([])
  })

  it('reports a source it cannot parse rather than passing it', () => {
    expect(violationsOf('var locale = ctx.locale', kernel)).toEqual([UNPARSEABLE])
  })
})
