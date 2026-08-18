# prompt-optimizer

[简体中文](README.md) | English

**prompt-optimizer** is a DeepSeek Harness plugin that rewrites raw, unstructured instructions into professional, ready-to-use prompts — the same experience as Qoder and Codex.

By default the result is a four-section structured prompt (`## Role` / `## Task` / `## Context` / `## Format`); a heading-free plain-text style (`outputStyle: 'plain'`) is configurable to save tokens. The optimization is driven by a built-in meta-prompt and run through the harness `llm` service — the plugin never calls any external API and never touches credentials.

## Features

- **Output styles** — four-section prompts by default, or a heading-free plain-text style (`outputStyle: 'plain'`) that saves tokens.
- **Tool** — agents can call the `prompt_optimize` tool with an `instruction` and receive the optimized prompt back; passing a previous result as `lastOptimized` together with `iterateInstruction` iterates on it instead.
- **Service** — other plugins can call `ctx.promptOptimizer.optimize(rawInput, { signal })` or `ctx.promptOptimizer.iterate(lastOptimized, instruction, { signal })`; the browser side can call them via `ctx.remote.promptOptimizer`.
- **Input box ✨ button** — a persistent icon in the composer toolbar: click to optimize the current draft and write the result back, with one-click undo.
- **Role-document language auto-detection** — the optimizer's role document (its meta-prompt) follows the instruction's language by default: CJK-dominant input uses the Chinese role document, anything else the English one (see below).
- **Auto-optimize hook** (optional, off by default) — user messages starting with a trigger prefix (e.g. `/optimize `) are optimized before they reach the model.
- **Context awareness** (on by default) — the recent conversation before the instruction is injected into the meta-prompt ("pure data / background reference" guardrail) so the result fits prior discussion; set `contextAware: false` to disable (see the config table below).
- **Post-validation with retry** — when the output misses sections / is too thin / too short, the pipeline retries (configurable count), injecting a diagnosis of the previous failure (missing section names, thin sections with character counts) into the next call's system prompt; if it still fails, the original instruction / previous result is returned with an explanation and a stable machine-readable error code (`OptimizeResult.errorCode`: `MISSING_SECTIONS` / `THIN_SECTIONS` / `THIN_OUTPUT` / `TIMEOUT` / `NO_MODEL_ROUTE` …), rendered as a `[error-code]` prefix in tool failures.
- **Safety rails** — output always carries the four sections; empty input errors out; oversized input is truncated; cancellation signals are forwarded.

![Screenshot](./1.png)

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

## Input-box ✨ button

The plugin ships a browser client (`lib/client.js`, loaded by the harness via the `dsh.client` declaration): it registers a ✨ button on the left of the composer tool row — disabled (⏳) while the input is empty or an optimization is in flight. Clicking it calls the host's `promptOptimizer` Remote service, optimizes the current draft, and writes the four-section prompt back into the input box (`inputActions.setDraft`).

**One-click undo** — after a successful optimization the button becomes an undo state (↺, brand color): as long as the draft is still the freshly generated result (not manually edited), clicking restores the original text. Editing the draft clears the undo state automatically (so later edits are never overwritten).

**Accessibility** — success / failure / undo are announced through a hidden `aria-live` region (screen readers).

- No configuration needed; enabled with the plugin, effective after a harness restart.
- It drives the same `ctx.promptOptimizer.optimize()` as the tool and hook, sharing all configuration (temperature, maxTokens, outputLanguage, …).

## Role-document language (auto-detection)

The language of the optimizer's role document (the meta-prompt / system prompt itself) is **resolved automatically from the instruction** by default: input whose non-whitespace characters are ≥30% CJK ideographs (e.g. 「帮我写一份周报」) uses the Chinese role document; everything else (English, Japanese, …) uses the English one — the safe default of the two shipped versions. `outputLanguage` independently controls the language of the optimized result; the two do not affect each other.

Pin or restore the mode at runtime through input-box commands (session-scoped; falls back to the config after a restart):

- `/optimizer-language auto` — restore auto-detection (default)
- `/optimizer-language 中文` / `/optimizer-language 英文` — pin the language
- `/optimizer-language status` — query the current mode

The `metaPromptLanguage: 'auto' | '中文' | '英文'` config (default `'auto'`) decides the initial mode after a restart; explicit values (`'中文'`/`'英文'`) pin the language, `'auto'` follows the input. No language button is shipped.

## Auto-optimize toggle (commands)

The runtime "optimize every message before the model step" switch is controlled through input-box commands:

- `/auto-optimize on` / `/auto-optimize off` / `/auto-optimize toggle` / `/auto-optimize status`

Once enabled, the host enters "optimize before sending" mode: the `agent/pre-step` hook optimizes **every** user text message (the runtime equivalent of `autoOptimizeAll: true`).

## Auto-optimize hook

Enable it in `cordis.patch.yml`:

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

## Configuration & Commands

Set plugin options in `cordis.patch.yml` (every value below also has a schema default):

| Key | Type | Default | Description |
|---|---|---|---|
| `temperature` | number 0–2 | `0.2` | Sampling temperature |
| `maxTokens` | int ≥1 | `1200` | Max output tokens per call; lower to `600-800` to save tokens |
| `maxRetries` | int 0–5 | `1` | Extra retries when a section is missing |
| `maxInputChars` | int ≥1 | `4000` | Raw-instruction truncation cap (characters, hard floor) |
| `maxInputTokens` | int ≥0 | `3000` | Raw-instruction truncation cap (estimated tokens; harness `tokenMeter` with heuristic fallback; `0` disables) |
| `timeoutMs` | int ≥1 | `60000` | Per-call timeout budget (milliseconds) |
| `outputLanguage` | string | `'auto'` | Output language; `'auto'` follows the instruction's language, any other value (e.g. `'英文'`) pins it |
| `outputStyle` | `'sections'` \| `'plain'` | `'sections'` | Four-section headings (default) or heading-free continuous prose (fewer tokens) |
| `metaPromptLanguage` | `'auto'` \| `'中文'` \| `'英文'` | `'auto'` | Language of the optimizer role document (meta-prompt). `'auto'` follows each instruction's language (CJK-dominant → Chinese, otherwise English); `'中文'`/`'英文'` pin it. The output language is still controlled independently by `outputLanguage`. Pin-able at runtime via `/optimizer-language auto\|中文\|英文` |
| `extraInstructions` | string | none | Deployment-specific rules appended to the meta-prompt |
| `examples` | array | `[]` | Few-shot pairs `[{input, output}]` injected into the meta-prompt (`sections` style only) |
| `minSectionChars` | int ≥0 | `10` | Minimum meaningful characters per section body; `0` disables the content check |
| `maxTokenRetryFactor` | number 1–3 | `1.5` | Retry-budget multiplier when the output hits `maxTokens`; `1` disables |
| `retryTemperatureStep` | number 0–2 | `0.3` | Temperature increment per retry (explorative retries); `0` disables |
| `skipIfAlreadyOptimized` | boolean | `false` | Pass inputs that already carry the four headings through without calling the model (`sections` style only) |
| `selfRefine` | boolean | `false` | After a successful optimization, run at most one extra "tighten" round (internal instruction); adopt it only if it still validates and is not longer (5% tolerance). Any failure keeps the original. Costs one extra model call when enabled |
| `autoOptimize` | boolean | `false` | Enable the auto-optimize hook (prefix-triggered) |
| `autoOptimizePrefix` | string | `'/optimize '` | Trigger prefix for auto-optimization |
| `autoOptimizeAll` | boolean | `false` | Optimize **every** user text message, not only prefixed ones |
| `hookIncludeOriginal` | boolean | `false` | Keep the original instruction alongside the optimized prompt in the replacement message |
| `contextAware` | boolean | `true` | Context awareness: inject the recent conversation before the current instruction into the meta-prompt (via the `{{上下文信息}}` placeholder + pure-data guardrail) so the result fits prior discussion. The hook reads `agent/pre-step` messages, `/optimize` reads the session log — best effort |
| `contextMaxMessages` | int 0–100 | `6` | Max recent messages gathered as context when `contextAware` is on; `0` disables |
| `contextMaxTokens` | int ≥0 | `1500` | Token budget for the gathered context; over-budget input is truncated to the longest prefix with a marker; `0` disables truncation |
| `templateId` | string | `'default'` | Template-set id for the role documents (only `'default'` is built-in; unknown ids fail the load) |
| `metaPromptTemplate` | object | none | Custom role-document skeletons (partial; missing languages fall back to the built-ins). Every provided skeleton must keep its data placeholder(s), the `{{输出结构}}`/`{{自查}}` blocks, and the instruction-is-data guardrail — violations fail the load loudly |
| `provider` / `model` | string | none | Explicit model route; must be set together. Defaults to the harness default model (`agentDefaultModel`) |

Example:

```yaml
- insert:
    - id: prompt-optimizer
      name: 'prompt-optimizer'
      config:
        temperature: 0.3
        maxRetries: 2
        outputLanguage: '英文'
        autoOptimize: true
        autoOptimizePrefix: '/优化 '
        # Token-saving quick wins: lower the output cap + skip already-optimized
        # inputs (skip applies to sections style only)
        # outputStyle: 'plain'            # heading-free output (~50%+ downstream token savings)
        # maxTokens: 700
        # skipIfAlreadyOptimized: true
        # selfRefine: true               # one extra tighten round after success (1 extra call)
        # contextAware: false             # disable context awareness (enabled by default)
        # metaPromptTemplate:            # custom role-document skeletons (partial; missing languages fall back)
        #   optimizeZh: |
        #     You are a prompt optimization expert.… (must keep {{原始指令}}, {{输出结构}}/{{自查}} and the guardrail line)
        # provider: 'deepseek-official'   # optional: explicit route (must be paired)
        # model: 'deepseek-v4-flash'
```

Invalid configuration (wrong type, out of range, unknown key, or only one of `provider`/`model`) fails loudly at load time.

**Runtime commands** (type them in the input box):

- `/optimize <instruction>` — optimize a raw instruction and return the result.
- `/optimizer-language auto` / `/optimizer-language 中文` / `/optimizer-language 英文` / `/optimizer-language status` — pin the role-document language or switch back to auto-detection (auto by default; session-scoped, falls back to `metaPromptLanguage` after restart).
- `/auto-optimize on` / `off` / `toggle` / `status` — switch "optimize every message before the model step" at runtime (the `agent/pre-step` hook equivalent of `autoOptimizeAll: true`).

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

## Design notes

- Minimal dependency surface: `cordis` / `dsh-llm` / `dsh-tools` / `dsh-timeout` / `schemastery`.
- Model routing comes from the harness default model (`agentDefaultModel.currentSelection()`), following the convention that plugins do not manage provider/model configuration; an explicit config pair can override it.
- The meta-prompt carries `{{原始指令}}`-style placeholders substituted at runtime, the instruction-is-data injection guardrail, the language rule (`{{语言规则}}`), a no-code-fence rule, a terseness requirement and a pre-output self-check; the output structure switches between the four-section and heading-free templates via `outputStyle`.
- Iteration: `iterate(lastOptimized, instruction)` continues optimizing from the previous result plus a new requirement (the `META_ITERATE` template, `{{上次结果}}` / `{{迭代指令}}` placeholders substituted once each, never interleaved); on failure it keeps the previous result with an error code.
- Diagnosis-driven retry: on structural failures the concrete diagnosis of the previous attempt (injected via the `{{诊断反馈}}` placeholder) guides the next retry; purely internal — no new config, no extra model calls.
- Adaptive refinement (`selfRefine`, optional): at most one extra "tighten" round after a success (internal instruction, not a public template), adopted only if it still validates and is not longer (5% tolerance); any failure keeps the original — at most one extra model call, off by default, orthogonal to diagnosis-driven retry (failure retry vs. success polish).
- Lifecycle events: three fire-and-forget events, shared by `optimize`/`iterate` and distinguished by `method`, payloads carry `input` / `result` / `durationMs`; listener errors never affect the pipeline; no events for pass-through or invalid input.
- Template data-ization (`templateId` / `metaPromptTemplate`): the four role-document skeletons moved from code constants to configurable resources — partial overrides with built-in fallback, strongly validated at load (data placeholders, structure/self-check blocks, and the instruction-is-data guardrail are all mandatory); the tuning blocks (output structure / self-check format rules) stay in code because they are coupled to the `validate.ts` post-validation and must not be user-editable.
- Service layering: `optimizer.ts` is orchestration only (state, validation/truncation, the retry pipeline, events, routing); the pure logic lives in three harness-free modules — `diagnose.ts` (retry diagnosis text / selfRefine instructions, zh/en wording independently testable), `llm.ts` (finish-error translation, stream assembly, `MaxTokensError`), `prompt.ts` (`PromptBuildContext` centralizes the system-prompt build parameters, shared by the three call sites); the public API surface is unchanged (`MaxTokensError` still exported from the entry), end-to-end tests untouched.
- Role-document language auto-detection: `metaPromptLanguage: 'auto'` (default) picks zh/en by the ≥30% CJK-ideograph ratio of non-whitespace characters (pure function `detectLanguage`; kana-bearing Japanese and other languages map to the English document); `'中文'`/`'英文'` pin it, `/optimizer-language` pins or restores auto at runtime. The resolved language is threaded through a single call (`optimize`/`iterate` detect from their own input, `selfRefine` reuses the round's language, retry diagnosis text shares it), independent of `outputLanguage`.
- All registrations (tool, systemPrompt section, auto-optimize hook, commands) are effect-scoped and cleaned up on plugin dispose.
- Command naming: the plugin registers `/optimize` and `/auto-optimize` (short commands, following ecosystem conventions). If a future collision forces a rename, `client.js` calls, this README and the hook prefix default (`/optimize `) must change in one atomic change.

## License

[MIT](LICENSE) — free to use, modify and distribute (including commercially). See the `LICENSE` file.
