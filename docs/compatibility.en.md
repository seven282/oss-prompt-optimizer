# Compatibility and failure modes

> 简体中文: [docs/compatibility.md](compatibility.md)
>
> This file is the **single authority** on compatibility design. The README keeps only a summary and
> source comments keep only a one-line reference. Related: `README.md` (for users), `AGENTS.md` (for
> modifiers), `CHANGELOG.md` (version history).

## 1. The hard constraint

This plugin and dsh run inside the **same Node process**, therefore:

> **No internal defect in the plugin may prevent `dsh web` from starting.**

dsh's domain packages (`dsh-llm`, `dsh-tools`, `dsh-timeout`…) are still at the `0.1.x-rc` stage, so
their exports get moved and renamed. If the plugin statically `import`s them at the top level and
resolution fails, **an ESM failure cannot be caught** and the whole server fails to start.

That one constraint derives the three rules below. Each is the product of a "the machine was
completely dead" incident, and each has happened once.

## 2. Rule R1 — dependency layering

`src/**` may statically import exactly two kinds of package:

1. **The framework itself, `@deepseek-ai/cordis`** (the only host dependency kept static);
2. **Packages this package installs itself** in its own `dependencies` (such as
   `@deepseek-ai/schemastery`).

**Every other host package is barred from static import.** It must go through
`src/compat/loader.ts`, which uses `createRequire` to load it **synchronously and lazily**:
`try/catch` plus a cache, where **failure returns `null` and never throws**.

Staying synchronous rather than going async keeps `apply()` synchronous, so registration order is
unchanged.

### The `verbatimModuleSyntax` trap

`tsconfig.json` enables `verbatimModuleSyntax`, so:

```ts
import type { X } from '@deepseek-ai/dsh-llm'   // ✅ fully erased, zero runtime cost
import { type X } from '@deepseek-ai/dsh-llm'   // ❌ compiles to `import {} from '…'` — still a runtime import
```

The inline `type` modifier is **not** erased into nothing; it leaves an **empty named-binding
import** that still resolves the host package during module instantiation. ⇒ **Host imports may only
use a top-level `import type`.** The `erased` case in `tests/policy-static-imports.test.ts` guards
this.

## 3. Rule R2 — the client inject contract

`exports.inject` in `client/client.js` **carries only services the client half truly cannot work
without** (currently just `remote`); **everything else goes through `ctx.get('<name>')` and is
null-checked**.

The reason: cordis's context is a Proxy, so reading a service that is not in `inject` **throws**
(`cannot get property "X" without inject`), and `apply()` does not catch it ⇒ **the entire client
half fails to register**: the ✨ button and the settings page both disappear, leaving
`failed to apply loader entry …` in the console.

`ctx.get(name)` goes through `ReflectService.get`, whose own comment reads *"without the inject
requirement"* ⇒ it returns the service or `undefined` and **never throws**. `ctx.effect` and friends
are cordis core methods and are safe.

## 4. Rule R2b — a dotted service name is not a parent property

The host's `dsh-api-gateway` uses `remoteServiceKey(ns)` = `'remote.' + ns` and registers a separate
service per remote namespace via `super(ctx, 'remote.commands')`. The namespace set is **only known
at runtime** (installed when a contribution mounts), so no whitelist can enumerate it.

cordis's `createTraceable`: when a service value carries `[symbols.tracker]`, reading
`service.property` is **rewritten** into `Reflect.get(ctx, '<service name>.<property>')` ⇒ it
**re-enters the inject gate**. Hence:

```js
ctx.get('remote').commands     // ❌ throws cannot get property "remote.commands" without inject
ctx.remote.commands            // ❌ same
ctx.get('remote.commands')     // ✅ take the full name in one go
```

Two consequences:

1. Nested services are always taken by their **full name**;
2. Take them **at call time** — the namespace may be mounted after this plugin's `apply()`.

Boundary (measured): scanning every dsh package finds 18 dotted service names and **all of them
carry the `remote.` prefix**; none of the 86 literal names passed to `super(ctx, '<literal>')`
contains a dot ⇒ `slots.*` / `locale.*` / `settingsScope.*` / `sessions.*` are safe today and only
`remote` forbids dotted reads.

### The two known blind spots of the gate

| Blind spot | Detail |
|---|---|
| The static regex reads one segment only | `ctx.remote.commands` is only judged as far as `remote` (which is in `inject`) and passes; a local variable from `ctx.get('remote')` followed by `remote.commands` is invisible entirely |
| A dishonest fake host | Serving services as **plain objects** makes `getTraceable` return them **unchanged** (no `[symbols.tracker]`), so nested reads never hit the proxy ⇒ the assertion passes vacuously |

**Faithful modelling = a real `Service` subclass + nested names registered as services too + a
reverse control asserting that the naive form must throw on that host.**

## 5. What happens when the host contract changes

| Host change | Consequence |
|---|---|
| A tool function is moved out of its package or renamed | **That feature degrades + one WARN line**; the host and remaining features keep working |
| A service is renamed (e.g. `systemPrompt`) | Only the matching feature disappears (per-feature gating, no whole-plugin failure) |
| An optional client service is missing or renamed (`locale`…) | Reached through `ctx.get()`, so only that wording is lost; the ✨ button and settings page still register |
| `BlockAssembler` is missing | `/optimize` returns `UNSUPPORTED_ENV` with an explicit message — it **fabricates no message and does not fail silently** |
| The client slot props contract is renamed | The candidate chain self-adapts; when all candidates fail it **registers no button** and prints a self-diagnosis log |
| The settings service changes generation (0.1.x `settingsScope` → 0.2.0 `configForms`) | The page reads `ctx.get('configForms')` only; when unavailable or read-only it **degrades to read-only with the reason stated**, and a write the host rejects reports that the host rejected it instead of a false "saved" |
| The domain packages upgrade wholesale (`0.1.5-rc` → `0.2.x`) | Runtime capability probing decides what is available; what is not degrades |

Degradation is never silent: constructing the plugin **always prints one compat report line**
(healthy `info`, degraded `warn`):

```
prompt-optimizer: host compat ok (defineTool=ok createUserMessage=ok BlockAssembler=ok)
prompt-optimizer: host compat DEGRADED (defineTool=MISSING …) — defineTool: the `prompt_optimize` tool is not registered; the /optimize command and the input-box button still work | …
```

## 6. How to verify after upgrading dsh

```sh
pnpm preflight       # P1–P12 (P11 is skipped unless --browser-e2e)
pnpm preflight --browser-e2e   # adds P11 (a real browser; must run outside the sandbox)
pnpm e3 --dsh-bin <target version's dsh/lib/bin.js>   # throwaway profile: install → start → uninstall
pnpm e4 --json e4.json                                 # real-browser settings surface: token → 8 fields → write
dsh web              # real machine: starts normally, one compat report line in the log
```

| Step | What it proves |
|---|---|
| P1 | Dependency surface: top-level bare-package imports across `lib/**/*.js` stay inside the whitelist (cordis + own dependencies) |
| P2 | Existence of `dsh.client.inject`: simulates real resolution and reports the tier it resolved from (plugin profile / shared anchor / dsh CLI bundle) |
| P3 | `client/client.js` and `lib/client.js` are byte-identical |
| P4 | typecheck → test → build |
| P5 | Compatibility report (advisory only, never blocking) |
| P6 | **Startup independence**: seals every `@deepseek-ai/dsh*` on both the ESM and CJS resolution paths inside a child process, then imports the entry — the dynamic proof that "a host upgrade costs features, never startup". Includes a reverse control (first proving the seal works, against "seal silently broken → assertion vacuous → always PASS") |
| P7 | **Client service-read contract**: a static scan plus a real execution of `apply()` from `lib/client.js` on a **faithful minimal host** (the only automated step in this project that runs the browser half). It scans two classes of violation: reading a non-injected service (R2), and treating a dotted service name as a parent property (R2b) |
| P8 | Committed-artifact freshness: every path the manifest declares must exist, be tracked by git, and have **no diff against HEAD** ⇒ a clean index is not the same as committed |
| P9 | Desktop / web dual compatibility |
| P10 | Evaluation-judge calibration (built-in reference pairs + a reverse control that a judge which cannot fabricate a score must be rejected) |
| P11 | Real-browser settings surface (`--browser-e2e`, off by default) |

`pnpm e3` / `pnpm e4` / `pnpm preflight --browser-e2e` **are all excluded from CI**: they need a
real host to start or a real browser, which would break offline reproducibility. All three support
`--json <path>` for machine-readable evidence.

## 7. Incident archive

Kept here so that source comments no longer have to retell them.

| Version | Symptom | Root cause | Guard today |
|---|---|---|---|
| **1.8.1** | `dsh web` would not start at all | A top-level static import of a host package failed to resolve `deepFreeze`; an ESM failure is uncatchable | Rule R1; P1 + P6 |
| **1.8.2** | The ✨ button and the settings page **disappeared together** (whole client half dead) | The client read an optional service that was not in `inject`; the Proxy threw and `apply()` did not catch it | Rule R2; `tests/client-inject-contract.test.ts` + `tests/client-apply.test.ts` + P7 |
| **1.8.3** | Same symptom, **the previous gate missed it** | `ctx.get('remote').commands` was rewritten by cordis into a read of `remote.commands`, hitting the inject gate again | Rule R2b; P7's faithful fake host + reverse control |
| **1.8.4** | The plugin market held the update back while `npm publish` looked fine | `lib/` was gitignored while `main`/`types`/`exports` all pointed into it ⇒ a commit carrying only `src/` is an uninstallable package (DSH STORE reads a fixed commit and never builds) | `lib/` is tracked + P8 (published paths must exist, be tracked, and have no diff against HEAD) |
| **issue #3** | The settings panel said "saved" and stored nothing | The client read the 0.1.x `settingsScope` (0.2.0 replaced it with `configForms`) and swallowed `set()`'s boolean; with no volatile field in the schema the entry did not appear at all | `src/live-config.ts` + the client checking `form.set()`'s return value + P11 |

## 8. The self-check principle for gates

**Every "this list must be empty" violation assertion must ship with a control assertion that proves
it can be non-empty.**

Otherwise the assertion degenerates into an eternal PASS: a broken seal, a dishonest fake host or a
wrong regex would never be noticed. The reverse controls in place today: P6 (the seal really works),
P7 (the naive form must throw on a faithful host), P10 (a judge that cannot fabricate a score must
be rejected), P11 (a bogus token must 401; the value about to be written must not already be on
disk).
