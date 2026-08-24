# prompt-optimizer

[简体中文](README.md) | English

**prompt-optimizer** turns a casually written sentence into a professional, ready-to-use prompt — the same experience as Qoder and Codex.

By default the result is heading-free plain text (`outputStyle: 'plain'`, fewer tokens); the three parseable labels (`outputStyle: 'role-task-goal'` — `角色：/任务：/目标：`) and the four-section structured style (`outputStyle: 'sections'` — `## Role` / `## Task` / `## Context` / `## Format`, also the internal reference frame during optimization) are configurable. The optimization is driven by a built-in meta-prompt and run through the harness `LLM` service — the plugin never calls any external API and never touches credentials.

## Features

- **Output styles** — heading-free plain text by default (`outputStyle: 'plain'`, fewer tokens), with three parseable labels (`outputStyle: 'role-task-goal'` — `角色：/任务：/目标：` or `Role:/Task:/Goal:`) or the four-section structured style (`outputStyle: 'sections'` — `## Role` / `## Task` / `## Context` / `## Format`) configurable.
- **Tool** — agents can call the `prompt_optimize` tool with an `instruction` and receive the optimized prompt back; passing a previous result as `lastOptimized` together with `iterateInstruction` iterates on it instead.
- **Service** — other plugins can call `ctx.promptOptimizer.optimize(rawInput, { signal })` or `ctx.promptOptimizer.iterate(lastOptimized, instruction, { signal })`; the browser side can call them via `ctx.remote.promptOptimizer`.
- **Input box ✨ button** — a persistent icon in the composer toolbar: click to optimize the current draft and write the result back; **clicking again while optimizing cancels**; success shows a transient "≈N tokens" cost hint; after success the button switches to undo (↺) — clicking restores the original text as long as the draft hasn't been manually edited; success / failure / undo announced via `aria-live` (screen readers).
- **Role-document language auto-detection** — the optimizer's role document (its meta-prompt) follows the instruction's language by default: CJK-dominant input uses the Chinese role document, anything else the English one; pin or restore at runtime via `/optimize --language`.
- **Auto-optimize hook** (optional, off by default) — user messages starting with a trigger prefix (e.g. `/optimize `) are optimized before they reach the model; toggle at runtime via `/optimize --auto on|off|toggle|status`.
- **Context awareness** (on by default) — the recent conversation before the instruction is injected into the meta-prompt ("pure data / background reference" guardrail) so the result fits prior discussion; set `contextAware: false` to disable.
- **Situation awareness** — the raw instruction plus conversation context is parsed into **role / task / goal profiles** and injected into the meta-prompt (`{{情境画像}}`), so the optimized `## Role` stays strongly tied to the task and the goal/constraints are preserved; a dropped goal/constraint triggers an in-budget retry (`goalAlignmentRetry: false` opts out); `iterate` detects goal drift and annotates the change; passing `sessionId` enables **per-session goal carry-over** (30-min TTL). Role extraction covers explicit identities, **capability** clauses (proficient in…), **behavior** rules (lead with conclusions, never guess) and scene-style identities (acting as…) — a bare capability clause is enough to be recognized; `situationProfileLevel` controls the injection budget (full/minimal/off).
- **Three-part role definition** — the optimized role is written as "identity + capability + behavior" (no "you are" prefix required; a capability or behavior clause alone qualifies); a per-task-type role-writing tip is injected (code → capability-oriented, writing → identity + genre, analysis → identity + method, ops → behavior + steps).
- **Faster optimization** — stream early-stop (**off by default** — output completeness first; opt in via `earlyStop: true`, with a per-section ≥40-char gate and sentence-boundary stop protection); first-call output-budget linkage (oversized output falls back to resume); an `optimizationProfile: 'fast'` one-click speed profile (skips validation and goal-alignment retries, disables self-refine — opt-in).
- **Result caching** — in-memory LRU+TTL cache of validated results; identical requests return with **zero model calls** (`cacheEnabled` on by default, cleared on restart).
- **Self-iteration system** — three-layer architecture for "the more you use it, the better it gets", zero token cost:
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

**Option 2: from GitHub (source build, requires `prepare` permission)**
```sh
dsh plugin --profile web add github:seven282/oss-prompt-optimizer
# pnpm ≥10 refuses to run prepare on first install; add the package key pnpm
# suggests to that profile's pnpm-workspace.yaml and retry:
#   allowBuilds:
#     oss-prompt-optimizer: true
# Pin a commit: github:seven282/oss-prompt-optimizer#<sha>
```

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
      name: 'prompt-optimizer'
      config:
        autoOptimize: true
        autoOptimizePrefix: '/optimize '
```

When enabled, any user message starting with `autoOptimizePrefix` is optimized by the `agent/pre-step` hook before it reaches the model step — the prefix is stripped, the remainder is sent as the raw instruction, and the model actually receives the optimized four-section prompt (with a short "auto-optimized" note).

- **Safety by design**: off by default; per-message opt-in (only prefixed messages are optimized) — normal conversation is never touched.
- **Graceful degradation**: on a non-matching prefix, an empty remainder, or an optimization failure, the original message reaches the model unchanged.
- At most one message is optimized per step, avoiding multiple model calls within a single step.
- The hook is registered in effect scope and removed automatically on plugin dispose.

> **Full configuration reference**: [docs/configuration.md](docs/configuration.md) (44 fields)

**Runtime commands** (type them in the input box):

- `/optimize <instruction>` — optimize a raw instruction and return the result.
- `/optimize --language auto` / `/optimize --language 中文` / `/optimize --language 英文` / `/optimize --language status` — pin the role-document language or switch back to auto-detection (auto by default; session-scoped, falls back to `metaPromptLanguage` after restart).
- `/optimize --auto on` / `off` / `toggle` / `status` — switch "optimize every message before the model step" at runtime (the `agent/pre-step` hook equivalent of `autoOptimizeAll: true`).
- `/optimize --set-profile fast|balanced` — temporarily override the optimization profile (session-scoped, restart fallback).
- `/optimize --set-local on|off|auto|hybrid` — temporarily override the local template mode (session-scoped, restart fallback).
- `/optimize --set-temperature <0-2>` — temporarily override the sampling temperature (session-scoped, restart fallback).
- `/optimize --clear` — clear all temporary overrides, restore to config values.
- `/optimize --insights` — display the current session's learning insights (task type distribution, preferred configs, success rate).

## Development

```sh
pnpm install --store-dir .pnpm-store --cache-dir .pnpm-cache   # sandboxed install
pnpm run typecheck    # tsc --noEmit
pnpm test             # vitest (mocked llm, no real credentials needed)
pnpm run build        # tsc -p tsconfig.build.json → lib/
```

All tests use a mocked `llm` stream and never read `.credentials.yaml`.

## Lifecycle events (for other plugins)

The `promptOptimizer` service emits events on the cordis event bus at key points of an optimization / iteration; other plugins can subscribe:

| Event | When | Payload |
|---|---|---|
| `prompt-optimizer/optimize:start` | input validated, before the first model call | `{ method, input }` |
| `prompt-optimizer/optimize:success` | success (`optimized: true`) | `{ method, input, result, durationMs }` |
| `prompt-optimizer/optimize:failure` | fallback (`optimized: false`) | `{ method, input, result, durationMs }` |

- `method` is `'optimize'` or `'iterate'` (both share the three events); `input` is the raw input (untruncated); `result` is the full `OptimizeResult`; `durationMs` is the pipeline duration in milliseconds.
- **Fire-and-forget observers**: listener errors are swallowed and never affect the pipeline.
- TypeScript subscribers get typed payloads directly (the `declare module '@deepseek-ai/cordis'` augmentation ships with the package), or can reference the event names via the `PROMPT_OPTIMIZER_EVENTS` constant.
- No events are emitted for pass-through (`skipIfAlreadyOptimized` hit) or invalid input (e.g. empty input).

## License

[MIT](LICENSE) — free to use, modify and distribute (including commercially). See the `LICENSE` file.
