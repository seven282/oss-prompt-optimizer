# prompt-optimizer

[简体中文](README.md) | English

**prompt-optimizer** turns a casually written sentence into a professional, ready-to-use prompt — the same experience as Qoder and Codex.

By default the result is heading-free plain text (`outputStyle: 'plain'`, fewer tokens); the three parseable labels (`outputStyle: 'role-task-goal'` — `角色：/任务：/目标：`) and the four-section structured style (`outputStyle: 'sections'` — `## Role` / `## Task` / `## Context` / `## Format`, also the internal reference frame during optimization) are configurable. The optimization is driven by a built-in meta-prompt and run through the harness `LLM` service — the plugin never calls any external API and never touches credentials.

## Features

- **Tool** — agents can call the `prompt_optimize` tool with an `instruction` and receive the optimized prompt back; passing a previous result as `lastOptimized` together with `iterateInstruction` iterates on it instead.
- **Service** — other plugins can call `ctx.promptOptimizer.optimize(rawInput, { signal })` or `ctx.promptOptimizer.iterate(lastOptimized, instruction, { signal })`; the browser side can call them via `ctx.remote.promptOptimizer`.
- **Input box ✨ button** — a persistent icon in the composer toolbar: click to optimize the current draft and write the result back; **clicking again while optimizing cancels**; success shows a transient "≈N tokens" cost hint; after success the button switches to undo (↺) — clicking restores the original text as long as the draft hasn't been manually edited; success / failure / undo announced via `aria-live` (screen readers).
- **Role-document language auto-detection** — the optimizer's role document (its meta-prompt) follows the instruction's language by default: CJK-dominant input uses the Chinese role document, anything else the English one; pin or restore at runtime via `/optimize --language`.
- **Auto-optimize hook** (optional, on by default, prefix-triggered) — user messages starting with a trigger prefix (e.g. `/optimize `) are optimized before they reach the model; unprefixed messages are unaffected; toggle at runtime via `/optimize --auto on|off|toggle|status`.
- **Context awareness** (on by default) — the recent conversation before the instruction is injected into the meta-prompt ("pure data / background reference" guardrail) so the result fits prior discussion; set `contextAware: false` to disable.
- **Situation awareness** — the raw instruction plus conversation context is parsed into **role / task / goal profiles** and injected into the meta-prompt (`{{情境画像}}`), so the optimized `## Role` stays strongly tied to the task and the goal/constraints are preserved; a dropped goal/constraint triggers an in-budget retry (`goalAlignmentRetry: false` opts out); `iterate` detects goal drift and annotates the change; passing `sessionId` enables **per-session goal carry-over** (30-min TTL). Role extraction covers explicit identities, **capability** clauses (proficient in…), **behavior** rules (lead with conclusions, never guess) and scene-style identities (acting as…) — a bare capability clause is enough to be recognized; `situationProfileLevel` controls the injection budget (full/minimal/off).
- **Three-part role definition** — the optimized role is written as "identity + capability + behavior" (no "you are" prefix required; a capability or behavior clause alone qualifies); a per-task-type role-writing tip is injected (code → capability-oriented, writing → identity + genre, analysis → identity + method, ops → behavior + steps).
- **Faster optimization** — stream early-stop (**off by default** — output completeness first; opt in via `earlyStop: true`, with a per-section ≥40-char gate and sentence-boundary stop protection); first-call output-budget linkage (oversized output falls back to resume); an `optimizationProfile: 'fast'` one-click speed profile (skips validation and goal-alignment retries, disables self-refine — opt-in).
- **Best-of-N selection** (1.12.0, active only with `selectCandidates > 1` — default 1 = off) — generate several candidates for ONE instruction (temperature ladder `base + i·0.35`) and keep the best one. Sampling is stochastic: the same instruction and model produce a good prompt on one draw and a mediocre one on the next, and the plugin previously had no way to notice. Three rules are non-negotiable: ① **the gate decides eligibility, the score only ranks** — a candidate that fails the structural contract or leaks an injection canary can **never** be chosen, however well a judge likes it; ② **another candidate must beat the baseline by `selectMinGain` (0.05)** to replace it, so a tie always keeps the first draw and enabling selection cannot make the common case worse; ③ an incomplete judge answer leaves that candidate **unscored** (not a partial mean), and a gate failure leaves it **unscored** (not a low score). Candidates are generated **concurrently** and only the **winner** is cached. With `selectJudge: false` it degrades to a zero-extra-call structural ranking. `/optimize --select` shows why the last run picked what it picked. ⚠️ The local-template path (`localTemplate: on|hybrid`) returns before the LLM pipeline, so it **produces no candidates** — let instructions take the full pipeline (the default `off`) to benefit.
- **Host feedback signal** (1.12.0) — reads the host's own `messageFeedback` (human thumbs up/down) and turns it into a **temperature bias**: ≥50% negative → +0.1 (explore more), ≤20% → −0.1 (converge), no effect below 3 judgments. It is a judgment about **past answers**, not a verdict on one optimization, so it only biases and states its reason — it never poses as a quality score. **Privacy**: only the rating, the category slug and whether a note existed are recorded; the **note text is never copied** into memory, the state file, an event or a log. `/optimize --feedback` shows the counts.
- **Measurement loop** (1.11.0) — `/optimize-eval` lets the plugin **measure itself** instead of only asserting shape. Three layers, cheapest first: ① the **structural gate** (free, and the *same* validation function the optimization pipeline uses — not a copy, so "what we accept" and "what we measure" cannot drift apart); ② **per-case expectations** (substrings that must / must not appear — this is how an injection canary is checked); ③ a **weighted judge score** on a 1–5 scale (specificity / context / output contract / fidelity / economy, with a **safety boundary** dimension enabled for the injection case; weights normalized to 0–1). The judge **must write its reason before its score**: a missing reason, a score written first, a non-integer or out-of-range score, or an invented dimension is **discarded**, and a dimension the judge skipped is reported as missing rather than guessed. `run` compares the aggregate against the recorded `baseline` and reports a **regression** beyond the tolerance; the run and its token usage (from the 1.10.0 ledger) are persisted so comparisons survive a restart. The dataset comes from three places: the built-in **golden set** (14 cases, 8 core by default), the `evalSet` config, and **mining this machine's own session history** (`--mine`, needs a host with `sessionQuery`) — mined instructions are used **in memory only and never written to the state file**, the same privacy rule the episode log follows. The judge can be turned off (`evalJudge: false` → fully offline, no extra calls) or pointed at its own model (`evalJudgeProvider` / `evalJudgeModel`; the optimizer's route is reused by default, and a distinct model is recommended to avoid self-evaluation bias). Preflight **P10** calibrates the grader against the shipped reference pairs, including reverse controls that a score-fabricating parser would fail.
- **Result caching** — in-memory LRU+TTL cache of validated results; identical requests return with **zero model calls** (`cacheEnabled` on by default, cleared on restart).
- **Real usage ledger** (1.10.0) — reads the host `usage` block (provider-reported tokens), accumulates `input / output / cacheRead / cacheWrite / reasoning`, and derives a **cache hit rate**, surfaced in `/optimize --stats` and `/optimize --status` together with the **last optimization's** and the **last call's** usage. When the provider reports nothing the output says so explicitly, instead of mixing heuristic estimates with measurements. `/optimize --status` also distinguishes "0 model calls (cache hit / local render)" from "calls that reported no usage".
- **Model identity + OTel signal** (1.13.0) — "which model did this run actually call" and an **OpenTelemetry GenAI-shaped** signal become visible: `/optimize --status` gains a "Target model: provider/model (reasoning effort)" line (the machine-readable tail of `/optimize --stats` gains `MODEL:` / `PROVIDER:` / `EFFORT:`), and the success/failure lifecycle payloads gain `route` and `genAi` (keyed by the OTel spec attribute names, so `span.setAttributes(payload.genAi)` needs no translation table). **Per run**: after a cache hit or a local zero-token render (no model call) the plugin reports **no model** — and no token counts it never measured.
- **Client copy follows the interface language** (1.13.1) — fixes "the settings page and the nav label are stuck in English after an update/reinstall, and a restart does not help". The client half used to **capture** one translator during `apply()`, but the host's locale plugin applies *asynchronously* (it awaits its native bootstrap before providing the service), so this plugin could finish first — after which every label resolved to the raw key. It now resolves the translator **per call**, and takes the framework-synthesized `t` seat the contract provides for an entry that declares `locale: NS` (the renderer re-derives that seat per locale revision, so its identity is what invalidates memoized children); the page subscribes to locale changes and re-renders itself, so the fallback path is covered too. The ✨ button's previously hardcoded Chinese `title`/`aria-label` and every announcement string are now in the dictionary. On a host with no locale face the namespace is **not declared** at all — the renderer throws for an entry that declares one nobody provides, so declaring it unconditionally would turn "no i18n here" into "the settings page is broken".
- **Settings panel** (1.7.8, requires the host to mount dsh-settings) — the plugin registers its full config as the `prompt-optimizer` namespace: all options (defaults/current values) are visible and editable under the Harness **Settings → plugin settings**; changes apply immediately and persist. On hosts without the settings service the bridge is skipped and config keeps resolving from `cordis.patch.yml` — zero behavioural change.
- **Self-iteration system** — three-layer architecture for "the more you use it, the better it gets", zero token cost. Learning data (episode log) and run statistics persist to `~/.dsh/oss-prompt-optimizer/state.json` by default (1.8.1; shared user-level learning across profiles, `$DSH_HOME` and the `stateFile` config override the path, `persistState: false` restores the in-memory-only behavior). **Privacy**: only behavioral metadata (task type / duration / tokens / acceptance) is stored — never the instruction text. The result cache (`cacheEnabled`) stays in-memory and clears on restart by design:
  - **Session learning** (Layer 1) — records success/failure experiences from each optimization (task type, output style, temperature, etc.), building a preference model
  - **Smart defaults** (Layer 2) — automatically recommends optimal config by task type (code/writing/analysis/ops/other)
  - **User overrides** (Layer 3) — runtime adjustments via commands (`--set-profile`, `--set-local`, `--set-temperature`), fallback on restart
  - Priority: user overrides > session learning > smart defaults > base config
- **Post-validation with retry** — when the output misses sections / is too thin / too short, the pipeline retries (configurable count), injecting a diagnosis of the previous failure (missing section names, thin sections with character counts) into the next call's system prompt; if it still fails, the original instruction / previous result is returned with an explanation and a stable machine-readable error code (`OptimizeResult.errorCode`: `MISSING_SECTIONS` / `THIN_SECTIONS` / `THIN_OUTPUT` / `TIMEOUT` / `NO_MODEL_ROUTE` …), rendered as a `[error-code]` prefix in tool failures.
- **Safety rails** — the output is always a complete, executable prompt (four sections or plain prose); empty input errors out; oversized input is truncated; cancellation is handled at the UI layer.

![Screenshot](./1.png)
![Screenshot](./2.png)

## Installation

Published on npm (`oss-prompt-optimizer`). Pick any of the three ways:

**Option 1: npm (recommended, no build permission needed)**
```sh
dsh plugin --profile web add oss-prompt-optimizer
```

**Option 2: from GitHub**
```sh
dsh plugin --profile web add github:seven282/oss-prompt-optimizer
# Pin a commit: github:seven282/oss-prompt-optimizer#<sha>
```
The built bundle (`lib/`) is committed — it *is* the published artifact — so installing from
source needs **no build permission** and pnpm ≥10/11 will not ask for `allowBuilds`. The build
only happens at `npm publish` time, driven by `prepublishOnly`.

**Option 3: from a local directory (development)**
```sh
dsh plugin --profile web add <project-path>
# Windows paths containing spaces get split; use a junction first:
#   New-Item -ItemType Junction -Path "C:\dsh-po" -Target "E:\<your-project-path>"
#   dsh plugin --profile web add C:\dsh-po
```

**Uninstall (reversible)**
```sh
dsh plugin --profile web remove oss-prompt-optimizer
```

Restart the harness (`dsh web`) after installing or removing the plugin.

### Runtime requirements & compatibility declaration

Declared per release in the manifest (`engines` + `dsh.compatibility`) so DSH STORE and
installers can check it:

| Item | Value |
|---|---|
| Node.js | `>=22` |
| DSH range | `^0.2.0-rc.2` |
| Verified releases | `0.2.0-rc.2` (CLI/web and the desktop runtime share the tuple; the desktop side carries disposable-profile install / start / uninstall evidence) |

This plugin declares the **current latest** DSH release only: older releases are served by older
plugin versions, so re-taking evidence for them would produce claims nobody reads.
`0.2.0-rc.2` is also the first release carrying the settings contract this plugin is built on
(`ctx.configForms` + volatile-backed forms); on anything older the panel degrades to **read-only
with an explanation** rather than pretending it can write.

> ⚠️ The range must enumerate tuples with `||`; writing `>=0.1.5-rc.1 <0.2.0` matches **no**
> `0.1.6-alpha.*` or `0.2.0-rc.*`. By the semver prerelease rule a prerelease version only
> satisfies a range when some comparator carries the *same* `[major.minor.patch]` plus a
> prerelease.

Reproduce the evidence locally (throwaway `DSH_HOME`, your real profile is untouched):
```sh
node scripts/e3-acceptance.mjs --dsh-bin <path/to/dsh/lib/bin.js> --json e3.json
node scripts/e4-settings-browser.mjs --json e4.json   # settings surface in a real browser: handshake → fields → write-through
# On Windows run this outside the assistant sandbox: `dsh web` calls reg.exe, and a blocked
# sandbox leaves the host hanging with no output at all.
```

## Quick scene templates (/template)

`/template <scene>` returns a ready-to-fill four-section template (Role / Task / Context / Format skeleton with placeholders) — **no model call, zero latency/cost** — for common scenes like a weekly report, email, copy, translation, data analysis, deployment checklist, etc. Covers all 22 subcategories (zh/en scene names and keywords matched); for personalized needs use `/optimize`.

**Pre-filled**: `/template <scene> <instruction>` (e.g. `/template 周报 总结本周进展`) returns a **filled four-section result** — when the local gate passes, the pure-function layer renders it locally (also **zero tokens, ~5ms**); when the instruction carries no extractable signal, it falls back to the skeleton with a hint to use `/optimize`.

## Auto-optimize

Toggle at runtime via commands (session-scoped, restart fallback):

- `/optimize --auto on` / `/optimize --auto off` / `/optimize --auto toggle` / `/optimize --auto status`

When enabled, the `agent/pre-step` hook optimizes **every** user text message (the runtime equivalent of `autoOptimizeAll: true`).

Or enable via config in `cordis.patch.yml`:

```yaml
- insert:
    - id: prompt-optimizer
      name: 'oss-prompt-optimizer'
      config:
        autoOptimize: true
        autoOptimizePrefix: '/optimize '
```

When enabled, any user message starting with `autoOptimizePrefix` is optimized by the `agent/pre-step` hook before it reaches the model step — the prefix is stripped, the remainder is sent as the raw instruction, and the model actually receives the optimized four-section prompt (with a short "auto-optimized" note).

- **Safety by design**: prefix-triggered only — unprefixed messages reach the model unchanged, normal conversation is never touched (`autoOptimize` is on by default but only applies to prefixed messages).
- **Graceful degradation**: on a non-matching prefix, an empty remainder, or an optimization failure, the original message reaches the model unchanged.
- At most one message is optimized per step, avoiding multiple model calls within a single step.
- The hook is registered in effect scope and removed automatically on plugin dispose.

> **Full configuration reference**: [docs/configuration.md](docs/configuration.md)

**Runtime commands** (type them in the input box):

- `/optimize <instruction>` — optimize a raw instruction and return the result.
- `/optimize --language auto` / `/optimize --language 中文` / `/optimize --language 英文` / `/optimize --language status` — pin the role-document language or switch back to auto-detection (auto by default; session-scoped, falls back to `metaPromptLanguage` after restart).
- `/optimize --auto on` / `off` / `toggle` / `status` — switch "optimize every message before the model step" at runtime (the `agent/pre-step` hook equivalent of `autoOptimizeAll: true`).
- `/optimize --set-profile fast|balanced` — temporarily override the optimization profile (session-scoped, restart fallback).
- `/optimize --set-local on|off|hybrid` — temporarily override the local template mode (default off, LLM path; session-scoped, restart fallback).
- `/optimize --set-temperature <0-2>` — temporarily override the sampling temperature (session-scoped, restart fallback).
- `/optimize --clear` — clear all temporary overrides, restore to config values.
- `/optimize --insights` — display the current session's learning insights (task type distribution, preferred configs, success rate).
- `/optimize --status` — display live runtime status (effective params & source, stats, real usage, selection & host feedback, eval score, preference summary, recent events) (also available on the Settings → Prompt Optimizer page).
- `/optimize --select` — the last selection's candidate count, winner and score (with an explanation of how to enable it when off).
- `/optimize --feedback` — host feedback counts and the temperature bias (states explicitly when the host exposes no such service).

### Evaluation commands (`/optimize-eval`)

`/optimize-eval` measures the quality of the optimizer's own output. A run costs
real model calls, so it only ever happens when you ask for it — never as a side
effect of `/optimize`:

- `/optimize-eval run [label] [--all] [--mine]` — run an evaluation: the golden set's **core** subset (8 cases) by default, `--all` for everything (plus your configured cases), `--mine` to append samples mined from session history. Prints the aggregate, the structural-gate pass rate, per-dimension means, a per-case breakdown, and the baseline comparison; the last line is a machine-readable token (`EVAL|SCORE:…|BASE:…|DELTA:…|VERDICT:…|CASES:…|GATE:…|LEAK:…`), and a run judged a **regression** returns an error result so a script or CI job can branch on it.
- `/optimize-eval baseline [label]` — record the most recent run (or the one with that label) as the comparison baseline.
- `/optimize-eval show` — the latest run plus its baseline comparison.
- `/optimize-eval list` — recent evaluation runs (time / aggregate / structural gate / label).
- `/optimize-eval rubric` — the scoring dimensions and weights currently in effect (after any `evalRubric` override).
- `/optimize-eval cases [--all]` — which case ids a run would use.

Typical use: `run` and `baseline` before touching a template or the pipeline,
then `run` again afterwards and let `DELTA` show that the change really was an
improvement rather than a feeling.

## Development

```sh
pnpm install --store-dir .pnpm-store --cache-dir .pnpm-cache   # sandboxed install
pnpm run typecheck    # tsc --noEmit
pnpm test             # vitest (mocked llm, no real credentials needed)
pnpm run build        # tsc -p tsconfig.build.json → lib/
pnpm preflight        # compatibility gate P1–P10; add --browser-e2e for P11 (real browser, outside the sandbox)
pnpm e3               # disposable-profile acceptance: install → start → uninstall (outside the sandbox)
pnpm e4               # settings surface in a real browser: handshake → fields → write-through (outside the sandbox)
```

All tests use a mocked `llm` stream and never read `.credentials.yaml`.

> **`lib/` is tracked.** It *is* the published artifact: `main` / `types` / `exports` all point into
> it, and DSH STORE only reads a fixed commit — it never runs install, prepare or build. So a change
> under `src/` must rebuild and commit `lib/` in the same commit; gate P8 fails when the artifacts are
> missing, ignored, or carry uncommitted drift.

## Compatibility & failure modes

This plugin runs in the **same Node process** as dsh, which imposes one hard constraint:

> **No internal defect in this plugin may prevent `dsh web` from starting.**

dsh's domain packages (`dsh-llm`, `dsh-tools`, `dsh-timeout`…) are still at `0.1.x-rc`, so exports get
moved and renamed. If the plugin statically `import`s them, a single failed resolution is
**uncatchable under ESM** and takes the whole service down — which is exactly what happened in the
1.8.1 `deepFreeze` incident.

### Rule R1

`src/**` may only statically import two kinds of package: the **framework itself
(`@deepseek-ai/cordis`)** and **packages this plugin installs via its own `dependencies`**.
Every other host package goes through `src/compat/loader.ts`, which loads it **synchronously and
lazily** — a failure returns `null` and never throws.

### Rule R2

In `client/client.js` (the browser half), `ctx.<name>` may **only** read a service that is declared
in `inject`. The cordis context is a Proxy, so reading a service that is not injected **throws** —
and `apply()` does not catch it, which means **one optional-service read takes the whole client half
offline**: the ✨ button and the settings page disappear together, leaving
`failed to apply loader entry … cannot get property "locale" without inject` in the console. That is
the 1.8.2 outage, so optional services (`locale` / `sessions` / `configForms`) always go through
**`ctx.get('<name>')`**, which does not require inject, returns the service or `undefined`, and never
throws.

### What happens when a host contract changes

| Host change | Consequence |
|---|---|
| A helper is moved out of a package / renamed | **That feature degrades + one WARN line**; host and every other feature keep working |
| A service is renamed (e.g. `systemPrompt`) | Only that feature disappears (per-feature gating, no more whole-plugin failure) |
| A client-side optional service is missing / renamed (`locale`…) | Read via `ctx.get()`, so only its wording is lost; the ✨ button and settings page still register |
| `BlockAssembler` is missing | `/optimize` returns error code `UNSUPPORTED_ENV` with explicit wording — **no faked response, no silent failure** |
| Client slot props contract is renamed | A candidate chain adapts; if all candidates fail the button is **not registered** and a self-diagnosing log is printed |
| Settings service renamed (0.1.x `settingsScope` → 0.2.0 `configForms`) | The panel only reads `ctx.get('configForms')`; when it is absent or not writable the panel turns **read-only and says why**, and a refused write reports "the host refused the change" instead of a false "Saved" |
| Domain packages jump versions (`0.1.5-rc` → `0.2.x`) | Runtime capability probing decides the usable surface; anything unavailable degrades |

Degradation is not silent: the plugin **always prints one compat report line** at construction
(`info` when healthy, `warn` when degraded):

```
prompt-optimizer: host compat ok (defineTool=ok createUserMessage=ok BlockAssembler=ok)
prompt-optimizer: host compat DEGRADED (defineTool=MISSING …) — defineTool: the `prompt_optimize` tool is not registered; the /optimize command and the input-box button still work | …
```

### How to verify after upgrading dsh

```sh
pnpm preflight       # P1 dependency surface / P2 inject resolution / P3 artifact consistency
                     # P4 typecheck+test+build / P5 compatibility report
                     # P6 startup independence (entry still instantiates with every dsh package sealed)
                     # P7 client service-read contract (R2/R2b static scan + apply() actually run
                     #    on a faithful minimal host)
                     # P8 committed runtime artifacts (published paths exist, are tracked, no drift)
                     # P9 desktop/web dual compat / P10 eval-grader calibration
                     # P11 the settings surface in a real browser (needs --browser-e2e, run outside the sandbox)
pnpm e3 --dsh-bin <that release's dsh/lib/bin.js>   # disposable profile: install → start → uninstall
pnpm e4 --json e4.json                              # settings surface in a real browser: handshake → 8 fields → write-through
dsh web              # on a real host: starts normally + one compat report line in the log
```

**P6** seals every `@deepseek-ai/dsh*` specifier on both the ESM and CJS resolution paths in a child
process, then imports the entry point — the dynamic proof that a host upgrade can cost features but
never startup. **P7** actually **executes** `apply()` from `lib/client.js` — the only automated step
in this project that runs the browser half at all — on a **faithful** minimal host (`remote` and
`remote.commands` both registered as real cordis `Service` instances), and scans for two classes of
violation: reading a service that was never injected (R2), and reading a **dotted service name** as a
property of its parent (R2b, e.g. `ctx.get('remote').commands`). Both classes are total-outage bugs
on a real machine, and each one happened once (1.8.2 / 1.8.3).

## Lifecycle events (for other plugins)

The `promptOptimizer` service emits events on the cordis event bus at key points of an optimization / iteration; other plugins can subscribe:

| Event | When | Payload |
|---|---|---|
| `prompt-optimizer/optimize:start` | input validated, before the first model call | `{ method, input }` |
| `prompt-optimizer/optimize:success` | success (`optimized: true`) | `{ method, input, result, durationMs, route?, genAi? }` |
| `prompt-optimizer/optimize:failure` | fallback (`optimized: false`) | `{ method, input, result, durationMs, route?, genAi? }` |

- `method` is `'optimize'` or `'iterate'` (both share the three events); `input` is the raw input (untruncated); `result` is the full `OptimizeResult`; `durationMs` is the pipeline duration in milliseconds.
- **`route` (1.13.0) is the model this run actually called**: `{ provider, model, reasoningEffort? }` (`reasoningEffort` is a plain string, no harness type). The `MODEL:` / `PROVIDER:` / `EFFORT:` fields of `/optimize --stats` and the "Target model" line of `/optimize --status` report the same fact, and all of them are **per run**: a cache hit or a local zero-token render (no model call) carries **no** `route` rather than the previous run's model.
- **`genAi` (1.13.0) is the same fact in OpenTelemetry GenAI shape**, keyed by the literal spec attribute names, so it can go straight to a span:

  ```ts
  ctx.on('prompt-optimizer/optimize:success', ({ genAi }) => {
    if (genAi) span.setAttributes(genAi)
  })
  ```

  It carries `gen_ai.operation.name` (`'chat'`), `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.conversation.id` (when the caller supplied a `sessionId`) and the five `gen_ai.usage.*` counts (input / output / cache_read / cache_creation / reasoning, mapping 1:1 onto the host-reported `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens`).
  ⚠️ Two honesty rules: **no model call means no `genAi` block at all** (a fabricated all-zero span describes a call that never happened), and **an adapter that reports no usage leaves all five counts out** (it does not report zeros it never measured). `gen_ai.response.model` is **not** emitted — the harness reports the model a request asked for, never a distinct model that served it.
- **Fire-and-forget observers**: listener errors are swallowed and never affect the pipeline.
- TypeScript subscribers get typed payloads directly (the `declare module '@deepseek-ai/cordis'` augmentation ships with the package), or can reference the event names via the `PROMPT_OPTIMIZER_EVENTS` constant.
- No events are emitted for pass-through (`skipIfAlreadyOptimized` hit) or invalid input (e.g. empty input).

## License

[MIT](LICENSE) — free to use, modify and distribute (including commercially). See the `LICENSE` file.
