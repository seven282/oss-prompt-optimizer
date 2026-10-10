# Configuration reference

> 简体中文: [docs/configuration.md](configuration.md)

The plugin line in `cordis.patch.yml` accepts the fields below; the defaults are built into the
schema.

## Core

| Field | Type | Default | Notes |
|---|---|---|---|
| `temperature` | number 0–2 | `0.2` | Sampling temperature |
| `maxTokens` | int ≥1 | `1200` | Output cap per call (tokens); lower it to `600-800` to save tokens |
| `maxRetries` | int 0–5 | `1` | Extra retries when a section is missing |
| `maxCalls` | int 1–20 | `4` | Total model-call budget for one optimization (first pass + expansion + retries); exceeding it falls back to the original text and reports `TOO_MANY_CALLS` |
| `outputLanguage` | string | `'auto'` | Output language; `'auto'` follows the instruction's language, any other value pins it |
| `outputStyle` | `'plain'` \| `'role-task-goal'` \| `'sections'` | `'plain'` | Output shape: continuous prose with no headings (default, cheapest), three labelled lines (`Role: / Task: / Goal:`, easy for a downstream step to parse; the goal line merges background constraints and the output contract), or four headings (`## Role` / `## Task` / `## Context` / `## Format`, which is also the internal frame used while optimizing) |
| `metaPromptLanguage` | `'auto'` \| `'中文'` \| `'英文'` | `'auto'` | Language of the optimizer's role document (the meta-prompt). `'auto'` detects the instruction's language (Chinese when ≥30% of characters are Han, otherwise English); the other two pin it. The *output* language stays under `outputLanguage`. At runtime `/optimizer-language auto\|中文\|英文` pins or restores detection |
| `selfRefine` | boolean | `false` | After a successful optimization, run at most one further "tighten" iteration (an internal instruction). It is adopted only if the result still passes validation and is no longer (5% tolerance); any failure reverts to the previous result. Costs one extra model call |
| `optimizationProfile` | `'balanced'` \| `'fast'` | `'balanced'` | Latency tier: `balanced` keeps every quality gate (validation retry, goal-alignment retry, `selfRefine`); `fast` skips the validation and goal-alignment retries and disables `selfRefine` — the first structurally valid output is accepted, worst-case latency drops sharply and rework rises (only takes effect when chosen explicitly) |

## Input control

| Field | Type | Default | Notes |
|---|---|---|---|
| `maxInputChars` | int ≥1 | `4000` | Hard character cap on the raw instruction |
| `maxInputTokens` | int ≥0 | `3000` | Estimated-token cap on the raw instruction; prefers the harness `tokenMeter` and falls back to a heuristic. `0` disables it |
| `timeoutMs` | int ≥1 | `60000` | Timeout budget per call (ms) |
| `extraInstructions` | string | none | Deployment-specific rules appended to the meta-prompt (domain requirements, style) |

## Output validation

| Field | Type | Default | Notes |
|---|---|---|---|
| `minSectionChars` | int ≥0 | `10` | Minimum meaningful characters per section; `0` disables content checks (headings only) |
| `maxTokenRetryFactor` | number 1–3 | `1.5` | Multiplier used to step up when the output hits the cap (1200→1800→2700…); an expansion does not consume a retry and resumes from the cut-off point. `1` disables it |
| `maxTokensCap` | int 1–128000 | `8000` | Ceiling for automatic expansion; `<= maxTokens` disables expansion |
| `maxTotalTokens` | int ≥0 | `20000` | Cumulative token ceiling for one optimization (system + generated, heuristic estimate). On reaching it the plugin stops expanding/retrying and returns through the normal degradation path with error code `BUDGET_EXCEEDED`. `0` disables it. Complements `maxCalls` (call count) and `maxTokensCap` (per-call output) |
| `retryTemperatureStep` | number 0–2 | `0.3` | Temperature increment per retry (exploratory retries); `0` disables it |
| `skipIfAlreadyOptimized` | boolean | `true` | Pass the input through untouched when it already carries four headings, without calling the model (the token-saving default; `sections` mode only; **a non-empty conversation context still re-optimizes**). English headings or their Chinese variants both count as already optimized |
| `outputLengthMaxTokens` | int ≥0 | `800` | Suggested length ceiling for the result (tokens, soft: it only asks the model to be concise, it neither blocks nor retries). `0` disables it. Independent of `maxTokens` |

## Auto-optimization

| Field | Type | Default | Notes |
|---|---|---|---|
| `autoOptimize` | boolean | `false` | Enable the auto-optimization hook (prefix-triggered) |
| `autoOptimizePrefix` | string | `'/optimize '` | Trigger prefix for auto-optimization |
| `autoOptimizeAll` | boolean | `false` | Hook optimizes **every** user text message, not just the prefix |
| `hookIncludeOriginal` | boolean | `false` | Keep the original text when the hook rewrites a message (original + result) |

## Cache

| Field | Type | Default | Notes |
|---|---|---|---|
| `cacheEnabled` | boolean | `true` | In-memory cache of validated results (a repeat request costs zero model calls; LRU + TTL, cleared on reload) |
| `cacheMaxEntries` | int 0–10000 | `200` | Entry ceiling (LRU eviction); `0` disables storage |
| `cacheTtlMs` | int ≥0 | `600000` | Entry lifetime (ms); `0` never expires |
| `cacheFuzzyMatch` | boolean | `true` | Near-miss warm start: on an exact miss, a similar cached instruction (or the same instruction under a new context) becomes the starting point for iteration instead of optimizing from scratch |
| `cacheFuzzyThreshold` | number 0–1 | `0.6` | bigram-Jaccard similarity threshold for a near miss |

## Context awareness

| Field | Type | Default | Notes |
|---|---|---|---|
| `contextAware` | boolean | `true` | Inject the recent conversation before the current instruction (through the `{{上下文信息}}` placeholder and its treat-as-data guardrail) so the result fits what was being discussed. In four-heading mode the facts may fill `## Context` (embedded instructions are still never executed). The hook reads `agent/pre-step` messages, `/optimize` reads the session transcript; both are best-effort |
| `contextMaxMessages` | int 0–100 | `10` | Ceiling on recent messages collected; `0` disables it |
| `contextMaxTokens` | int ≥0 | `800` | Token budget for the context; overflow is truncated to the longest prefix plus a marker. `0` disables truncation |

## Situation profile

| Field | Type | Default | Notes |
|---|---|---|---|
| `situationProfileLevel` | `'full'` \| `'minimal'` \| `'off'` | `'full'` | Budget for the `{{情境画像}}` block: `full` emits role + goal + constraints; `minimal` keeps goal/constraints only (no role signals, cheaper); `off` omits it. Only the situation block is affected — `{{任务类型}}` is not |
| `goalAlignmentRetry` | boolean | `true` | Whether an unaligned goal/constraint (a failing `goalAlignment`) may spend a validation retry: `true` preserves goal fidelity, `false` accepts the structurally valid output and saves a call. Forced off under `optimizationProfile: 'fast'` |

## Local templates

| Field | Type | Default | Notes |
|---|---|---|---|
| `localTemplate` | `'on'` \| `'off'` \| `'hybrid'` | `'off'` | Local template path: structured subcategory scenes (weekly report, email, data analysis, deployment…) are rendered by the pure-function layer into a finished four-section result (zero tokens, ~5 ms). `off` (default) disables it entirely and always runs the LLM pipeline (most predictable). `on` renders locally on a subcategory hit (0 tokens, fastest). `hybrid` renders directly when the goal anchors align (`goalAnchorsScore` ≥ `hybridAlignThreshold`) and otherwise goes to the LLM (`refined: true`). ⚠️ `'auto'` was removed in 1.8.0 — writing it **fails config loading** |
| `hybridAlignThreshold` | number 0–1 | `0.4` | Anchor-alignment threshold for `hybrid`: below it the local result is refined; at or above it the result is returned as is. `0.4` refines only bare instructions with no goal anchor at all; `0.8` refines almost everything |

## Streaming

| Field | Type | Default | Notes |
|---|---|---|---|
| `earlyStop` | boolean | `false` | Early stream termination (**off by default** — complete output wins). When enabled: each section must hold ≥40 real characters and the total ≥120 before endgame detection starts, and the stream stops early only on a sentence boundary (period or newline) after 16 consecutive chunks each adding fewer than 24 characters. `false` always consumes the full stream |

## Templates and examples

| Field | Type | Default | Notes |
|---|---|---|---|
| `examples` | array | built-in fallback | few-shot `[{input, output}]` pairs injected into the meta-prompt (`sections` mode only). When unset, one built-in pair is chosen from the task type and the role document's language (code/writing/analysis/ops, four pairs per language, `other` falls back to writing; a subcategory hit wins — `code-bugfix` gets a root-cause → minimal-fix → regression example). An explicit value overrides the built-ins |
| `builtinExamples` | boolean | `true` | Whether to inject built-in examples when `examples` is unset; `false` turns them off entirely (saves ~200 input tokens per call on short instructions) |
| `templateId` | string | `'default'` | Role-document template set id (only the built-in `'default'` exists; an unknown id throws at load) |
| `metaPromptTemplate` | object | none | Custom role-document skeletons (individual fields optional, missing languages fall back). Each skeleton must keep its data placeholder(s), the `{{输出结构}}`/`{{自查}}` blocks and the treat-as-data guardrail; a violation throws at load |

## Model routing

| Field | Type | Default | Notes |
|---|---|---|---|
| `provider` / `model` | string | none | Explicit model route; the two must be configured together. When absent the harness default model (`agentDefaultModel`) is used |

## Need sensing

| Field | Type | Default | Notes |
|---|---|---|---|
| `senseNeeds` | boolean | `false` | Need sensing / "dreaming" mode: append a clearly labelled "extended insight (AI inference)" appendix (deeper goal, implicit constraints, quality bar, follow-up questions). The inference never enters the prompt body |

## Configuration examples

### Basic

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
```

### Token-saving preset (recommended)

```yaml
- insert:
    - id: prompt-optimizer
      name: 'oss-prompt-optimizer'
      config:
        maxTokens: 1200                # output cap (plugin default; hitting it triggers factor-based expansion)
        skipIfAlreadyOptimized: true   # pass four-section input straight through, zero model calls (already on)
        contextMaxTokens: 800          # keep the context lean (already on)
        outputStyle: 'sections'        # keep four headings for structure-sensitive work; 'plain' saves 50%+ downstream
        selfRefine: false              # off by default: do not spend an extra call on tightening
```

### Fast tier (target 3–5 s, quality kept)

```yaml
- id: prompt-optimizer
  config:
    optimizationProfile: 'fast'   # skips the correction retries and selfRefine — the first output still passes the structural gate
    maxCalls: 3                   # quality guardrail: first pass plus at most 2 expansions (long output is not truncated)
    maxTokens: 1200
```

### Example-augmented (recommended, steadier output)

```yaml
- insert:
    - id: prompt-optimizer
      name: 'oss-prompt-optimizer'
      config:
        outputStyle: 'sections'        # examples are injected in sections mode only
        examples:
          - input: '写一个 Python 脚本读取 CSV 并按指定列求和'
            output: |
              ## Role
              资深 Python 工程师，擅长 pandas。

              ## Task
              编写脚本读取 CSV 并按指定列求和，输出结果文件；脚本须可直接运行并处理缺失值。

              ## Context
              输入 CSV 路径；输出结果 CSV；不修改原文件。

              ## Format
              完整可运行的 .py 代码 + 顶部使用说明（依赖、运行命令），不超过 200 行。
          - input: '写一份新产品发布公告'
            output: |
              ## Role
              资深品牌文案撰稿人。

              ## Task
              写一份 200 字内的新产品发布公告，突出核心卖点并给出行动号召。

              ## Context
              面向潜在用户；语气专业热情；不夸大功能。

              ## Format
              标题 + 正文段落，附 3 个备选标题。
```

## Evaluation (`/optimize-eval`, 1.11.0)

| Field | Type | Default | Notes |
|---|---|---|---|
| `evalThreshold` | number 0–1 | `0.6` | Composite-score threshold; below it the run is reported as `below-threshold` |
| `evalRegressionTolerance` | number 0–1 | `0.02` | How far below the baseline counts as a regression. **A regression is judged before a below-threshold score** (direction first, absolute value second) |
| `evalMaxCases` | number | `8` | Case cap for `run` **without** `--all` (`0` = no cap, all core cases). The default runs the core subset so two runs measure the same cases. ⚠️ `--all` means "every case" and is therefore **not subject to this cap** (since 1.12.1; before that `--all` was a no-op under the default config and the six non-core cases never ran). An explicit `maxCases` from the caller still wins over both |
| `evalJudge` | boolean | `true` | Enable the LLM judge. `false` runs the deterministic layer only (structural gate + expected substrings), fully offline with no extra calls |
| `evalJudgeProvider` | string | — | Judge model route (must be configured together with `evalJudgeModel`, otherwise loading throws). When unset it reuses the optimizer route; **a different model is recommended** to avoid self-preference bias |
| `evalJudgeModel` | string | — | Judge model id (see above) |
| `evalMineSessions` | boolean | `false` | Mine real instructions from this machine's session history (`sessionQuery` full-text search) as evaluation cases. **Privacy**: mined instructions are used in memory only and are **never written to the state file** (scores and lengths only), the same rule as the episode log |
| `evalMineLimit` | number | `5` | Cap on samples appended per mining run |
| `evalSet` | array | — | Deployment-specific cases appended after the built-in golden set; an `id` matching a built-in case **replaces** it. Fields: `id?`, `instruction` (required), `dimensions?`, `mustInclude?`, `mustNotInclude?` (injection canary), `injection?` |
| `evalRubric` | array | — | Override the built-in scoring dimensions: `{ id, weight?, enabled? }`. A misspelled `id` fails **at load** rather than silently scoring with the default weight |

Built-in dimensions (`/optimize-eval rubric` lists them): `specificity` 0.25, `output-contract`
0.25, `context` 0.2, `fidelity` 0.2, `economy` 0.1, plus an **on-demand** `safety` 0.15 for
injection cases. Scores are 1–5, weighted-averaged and normalized to 0–1.

The state file `~/.dsh/oss-prompt-optimizer/state.json` keeps the last ten evaluation runs and the
baseline (`evalRuns` / `evalBaseline`). Older state files without those fields are treated as empty
rather than discarding existing statistics.

## Candidate selection and host feedback (1.12.0)

| Field | Type | Default | Notes |
|---|---|---|---|
| `selectCandidates` | number 1–5 | `1` | best-of-N candidate count. `1` (default) is the historical behaviour at zero extra cost; `> 1` generates N candidates for one instruction (temperature `base + i·0.35`, capped at 2) and keeps the best. Cost and latency rise linearly; `/optimize --select` shows the last result |
| `selectMinGain` | number 0–1 | `0.05` | Minimum lead required to replace the first candidate. A tie or a thin lead always **keeps the first candidate**, so selection can never make the common case worse |
| `selectJudge` | boolean | `true` | Whether to rank candidates with the judge (the 1.11.0 rubric). `false` costs no extra calls and degrades to a structural heuristic (longer wins). **Independent of** the evaluation's `evalJudge` |
| `feedbackAdapt` | boolean | `true` | Whether to read the host's `messageFeedback` and turn it into a sampling-temperature bias (≥50% negative → +0.1; ≤20% → −0.1; inactive below 3 samples). **Only the rating, the category and whether a note exists are kept — the note text is never copied** |
| `feedbackScanLimit` | number 1–32 | `8` | How many sessions `/optimize --feedback` and `--status` may read |

**The three rules of selection** (read this before changing the code): ① the structural gate decides
**eligibility** and the score only decides **order** — a candidate that fails a gate (including an
injection-canary leak) can never win; ② replacing the first candidate requires beating it by
`selectMinGain`; ③ a dimension the judge skipped leaves that candidate **unscored**, not partially
averaged. Candidates are generated concurrently and **only the winner enters the cache**.

⚠️ **Mutually exclusive with the local template path**: `localTemplate: on|hybrid` returns before
the LLM pipeline, so no candidates are produced. To benefit from selection, let the instruction run
the full pipeline (the default `off`).

An invalid configuration (wrong type, out of range, unknown key, only one of provider/model) fails
loudly at load.

## Settings sidebar page (fixed in 1.13.1)

The page at "Settings (bottom left) → Prompt Optimizer" lists **only the eight switches a user has
to decide on**. Everything else (temperature, budgets, templates, evaluation…) is tuned by default
and still lives in `cordis.patch.yml`:

| Field | Type | Default |
|---|---|---|
| `outputStyle` | select | `plain` |
| `situationProfileLevel` | select | `full` |
| `contextAware` | boolean | `true` |
| `cacheEnabled` | boolean | `true` |
| `optimizationProfile` | select | `balanced` |
| `localTemplate` | select | `off` |
| `autoOptimize` | boolean | `true` |
| `autoAdapt` | boolean | `true` |

**Write contract (0.2.0)**: the page takes this plugin entry's form from `ctx.get('configForms')`
(`configForms.get('<host entry id>')`, where the entry id and the settings namespace are the same
string `prompt-optimizer`). Both `set()` and `unset()` resolve to a **boolean**, and `true` means
the host accepted the write. The page reads that value: on `false` it reports that the host rejected
the change, and it shows "saved" only on a real acceptance. The loader then refreshes it **in
place** through `loader/volatile-update`, without remounting the plugin.

**Read-only degradation**: when `get()` yields no form, or `status !== 'ready'`, or
`writable === false`, the page greys out every input and "restore all defaults" and states the
reason (the host exposes no writable config service / this connection is read-only / still loading)
instead of rendering inputs that look usable.

**Why the fields must be volatile**: dsh-settings only projects an entry into a form when the schema
carries a `volatile` node (`volatileForm()` returns `undefined` without one ⇒ `describe()` returns
an empty array ⇒ the namespace does not appear at all). These eight fields are therefore marked
`.volatile()` in `src/config.ts`, and they **must be read per use** rather than cached as plain
values at construction time.

> ⚠️ Before marking a new field `.volatile()`, confirm it is read per use at runtime. Fields
> resolved once at construction (`templates` / `cacheTtlMs` / `persistence` / `evalRubric` /
> `maxCalls`…) would only lie if marked volatile: the panel accepts the edit and nothing changes.
> `LIVE_CONFIG_KEYS` in `src/config.ts` is the whitelist and `tests/config.test.ts` guards it in
> both directions.

## FAQ

### `/api/changes.summary` returns 404 in the console

Opening certain past turns of the right-hand "changes this turn" panel logs this in the browser
console:

```
GET /api/changes.summary?sessionId=…&seq=…  404 (Not Found)
```

**This is neither an error in this plugin nor a host bug — it is how the "changes / review" panel is
designed, and it needs no fix.**

The route belongs to the host package `@deepseek-ai/dsh-client-ui-deliverables` (the "changes this
turn" tab in the right sidebar) and its data source is the **in-process memory** of
`dsh-workspace-changes`:

```js
byId.get(sessionId)?.summary(seq)   // written only on turn/start; cleared on session/disposed or plugin unload
```

The host's own source comment reads *"404 once the Host no longer serves it"* — by design.

| Question | Answer |
|---|---|
| Why do only some `seq` values 404? | **Expected.** Only turns this dsh process has run are queryable; after restarting `dsh web`, the review panel for older turns cannot open |
| Is the change from that turn lost? | **No.** The file changes are on disk and in git; the panel is only a summary view |
| Does it affect plugin features or self-iteration? | **No.** The plugin neither calls that route nor emits `workspace/changes` events |

How to verify: this repository references neither `changes.summary` nor `changes.diff` nor
`changes-review`; the plugin writes its self-iteration data to
`$DSH_HOME/oss-prompt-optimizer/state.json` (outside the workspace, through Node `fs`, not the host
recorder); and the auto-optimization hook only rewrites `payload.messages` at `agent/pre-step`,
**appending no session event and therefore not disturbing `seq` alignment**.

**Workaround**: refreshing within the same process does not 404; to review older changes after a
restart, read the git log rather than relying on that panel.
