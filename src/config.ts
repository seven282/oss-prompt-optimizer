import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** One few-shot demonstration injected into the meta-prompt. */
export interface PromptExample {
  /** The raw instruction. */
  input: string
  /** The expected optimized prompt (four sections). */
  output: string
}

/**
 * Partial custom role-document skeletons. Missing languages fall back to the
 * built-in templates (`templateId: 'default'`); every provided skeleton must
 * keep its data placeholder(s), the `{{输出结构}}` / `{{自查}}` blocks, and
 * the instruction-is-data guardrail line (see `validateTemplateSet`).
 */
export interface CustomTemplateSet {
  optimizeZh?: string
  optimizeEn?: string
  iterateZh?: string
  iterateEn?: string
}

/** Complete, validated plugin configuration. */
export interface Config {
  /** Sampling temperature for the optimization call. */
  temperature: number
  /** Upper bound on generated output tokens. */
  maxTokens: number
  /** Extra attempts after the first call when the four-section validation fails. */
  maxRetries: number
  /**
   * Unified per-optimization model-call budget (first call + expansions +
   * validation retries together). Exceeding it degrades to the original
   * instruction with `TOO_MANY_CALLS` — bounds worst-case cost/latency.
   */
  maxCalls: number
  /** Cap on the raw instruction fed to the model (characters). */
  maxInputChars: number
  /** Cap on the raw instruction fed to the model (estimated tokens); `<= 0` disables. */
  maxInputTokens: number
  /** Cooperative per-call timeout budget in milliseconds. */
  timeoutMs: number
  /**
   * Output language for the optimized prompt. `'auto'` (default) follows the
   * instruction's language; any other non-empty value pins the language.
   */
  outputLanguage: string
  /**
   * Output style for the optimized prompt. `'sections'` (default) emits the
   * four section headings (## Role / ## Task / ## Context / ## Format);
   * `'plain'` emits a heading-free continuous prompt (fewer tokens);
   * `'role-task-goal'` (1.6.5) emits three parseable labels — 角色/任务/目标
   * (zh) or Role:/Task:/Goal: (en) — so downstream parsers can extract the
   * role, the task and the goal directly.
   */
  outputStyle: 'sections' | 'plain' | 'role-task-goal'
  /**
   * Language of the optimizer's role document (the meta-prompt / system
   * prompt). `'auto'` (default) follows each instruction's language (`'中文'`
   * for CJK-dominant input, `'英文'` otherwise); `'中文'`/`'英文'` pins it.
   * This only changes the instructions the optimizer itself follows — the
   * output language of the optimized prompt is controlled by
   * `outputLanguage` independently. Pin-able at runtime via the
   * `/optimizer-language` command (auto | 中文 | 英文).
   */
  metaPromptLanguage: 'auto' | '中文' | '英文'
  /** Whether the auto-optimize hook is enabled (see `autoOptimizePrefix`). */
  autoOptimize: boolean
  /** Prefix that marks a user message for automatic optimization. */
  autoOptimizePrefix: string
  /**
   * Optional deployment-specific rules appended to the meta-prompt (e.g.
   * domain requirements or style preferences). Multi-line text allowed.
   */
  extraInstructions?: string
  /** Optional few-shot demonstrations injected into the meta-prompt. */
  examples?: PromptExample[]
  /**
   * Minimum non-whitespace characters each section body must contain for the
   * four-section validation to pass; `0` disables the content check.
   */
  minSectionChars: number
  /**
   * Multiplier applied to the effective `maxTokens` when a call finishes with
   * `max-tokens` (a truncated output). The jump expansion (跳档) grows the
   * budget by this factor up to `maxTokensCap`, does NOT consume the retry
   * budget, and resumes from the truncated prefix (断点续传). `1` disables
   * the expansion.
   */
  maxTokenRetryFactor: number
  /**
   * Hard cap for auto-expanded `maxTokens` (`max-tokens` truncation grows by
   * `maxTokenRetryFactor` up to this value). `<= maxTokens` disables
   * expansion. Default 8000 keeps runaway output bounded.
   */
  maxTokensCap: number
  /**
   * Cumulative token ceiling across ALL calls of ONE optimization — system
   * prompts plus newly generated text per call (plugin heuristic estimate).
   * Once spending reaches this bound, expansion jumps and validation retries
   * stop and the best result so far degrades as usual (`BUDGET_EXCEEDED`).
   * `0` disables the leash. Insurance against runaway retry storms (1.6.8 D1)
   * — a spend bound, complementary to `maxCalls` (a call-count bound).
   */
  maxTotalTokens: number
  /**
   * Temperature increment applied per retry attempt (bounded by 2), giving
   * retries more diversity. `0` disables the bump.
   */
  retryTemperatureStep: number
  /**
   * When true, an input that already carries the four headings passes through
   * unchanged (no model call — the token-saving default; re-optimizing an
   * already-optimized prompt costs nothing). Recognized under the canonical
   * English headings or their Chinese variants (`## 角色` / `## 任务` /
   * `## 背景` / `## 输出` etc., see `hasOptimizedSections`).
   */
  skipIfAlreadyOptimized: boolean
  /**
   * When true, a successful optimization runs one optional refinement round:
   * the result is passed through the iteration pipeline with a terse-only
   * instruction and adopted only if it still passes validation and is not
   * longer (5% tolerance). Default `false` — costs one extra model call
   * when enabled; any refinement failure keeps the original result.
   */
  selfRefine: boolean
  /** When true, the auto-optimize hook optimizes every user text message, not only prefixed ones. */
  autoOptimizeAll: boolean
  /** When true, the hook's replacement message keeps the original instruction text alongside the optimized prompt. */
  hookIncludeOriginal: boolean
  /**
   * When true, validated optimization results are cached in memory keyed by
   * the exact request (route + system + truncated instruction + truncated
   * context): a repeat returns the previous result with zero model calls.
   * In-memory only, never persisted (see ADR-008).
   */
  cacheEnabled: boolean
  /** Max cached results before LRU eviction; `0` disables storage. */
  cacheMaxEntries: number
  /** Cache TTL in milliseconds; `0` disables expiry. */
  cacheTtlMs: number
  /**
   * Near-miss warm start (阶段 1A): on an exact cache miss, a similar cached
   * instruction (or the same instruction with a different context) seeds an
   * `iterate` refinement instead of optimizing from scratch — cheaper, faster,
   * and the result reflects the NEW input.
   */
  cacheFuzzyMatch: boolean
  /** Bigram-Jaccard similarity threshold for the near-miss warm start (0..1). */
  cacheFuzzyThreshold: number
  /**
   * 需求感应 / 造梦模式 (阶段 2A, default off): when enabled, the optimizer
   * also infers the user's deeper needs — deep goal, implicit constraints,
   * quality criteria, likely follow-ups — and appends them as a clearly
   * marked `--- 延伸洞察（AI 推断）---` appendix after the optimized prompt.
   * Inferred content never mixes into the four-section body.
   */
  senseNeeds: boolean
  /**
   * When true, optimization includes recent conversation context (the
   * messages before the instruction, injected as the `{{上下文信息}}` block
   * with the pure-data guardrail). `true` (default) keeps the optimizer aware
   * of the conversation; set `false` to make it blind to it.
   */
  contextAware: boolean
  /** Maximum number of recent messages gathered as context when `contextAware` is on. */
  contextMaxMessages: number
  /**
   * Token budget for the gathered context; `<= 0` disables the token guard.
   * The context is truncated to the longest prefix within budget. The lean
   * default keeps context background-sized (most short discussions fit).
   */
  contextMaxTokens: number
  /**
   * Suggested upper bound for the length of the optimized prompt (in tokens),
   * injected into the role document as a soft guideline — the model aims to
   * stay within it but nothing is rejected or retried when it exceeds. `0`
   * disables the hint. Distinct from `maxTokens` (the hard per-call output
   * cap of the model call).
   */
  outputLengthMaxTokens: number
  /**
   * Injection budget for the situation profile (`{{情境画像}}` block):
   * `'full'` (default) injects role + goal + constraints (and the iteration
   * drift line), `'minimal'` injects goal/constraints only (no role signals,
   * leaner), `'off'` injects nothing. Only controls the situation block —
   * the `{{任务类型}}` hint is unaffected.
   */
  situationProfileLevel: 'off' | 'minimal' | 'full'
  /**
   * Whether a goal-alignment miss consumes a validation retry (latency
   * optimization P0-2). `true` (default) keeps the situation layer's retry:
   * when the output drops the instruction's goal/constraint and retry budget
   * remains, fold the misalignment into the diagnosis and retry. `false`
   * accepts the structurally-valid output as-is — saves the retry call at
   * the cost of goal fidelity. `optimizationProfile: 'fast'` forces `false`.
   */
  goalAlignmentRetry: boolean
  /**
   * Latency/speed profile (latency optimization P1-2). `'balanced'` (default)
   * keeps every quality gate (validation retries, goal-alignment retries,
   * self-refine). `'fast'` trades corrective calls for time: validation
   * retries and goal-alignment retries are skipped and `selfRefine` is
   * disabled — the output is accepted after the first structurally-valid
   * attempt, so worst-case latency drops at the cost of more rework.
   */
  optimizationProfile: 'balanced' | 'fast'
  /**
   * Early-stop the stream once the output is structurally valid and enters
   * its tail (latency optimization P1-1). `false` (default, since 1.4.5)
   * always consumes the full stream — output completeness wins. `true`
   * explicitly enables early-stop: once the four sections (or plain content)
   * pass the hardened validation (≥40 chars per section, ≥120 total) and the
   * stream keeps producing little new content, stop at a sentence boundary —
   * saves tail-token latency without truncating mid-sentence.
   */
  earlyStop: boolean
  /**
   * Whether to inject the built-in few-shot example pair when no explicit
   * `examples` are configured (1.4.0+). `false` disables the built-ins —
   * useful for short instructions where the example pair would dominate the
   * prompt-side token budget (1.4.6). Explicit `examples` always win.
   */
  builtinExamples: boolean
  /**
   * Whether to inject scene reference (role library + sub-topic templates)
   * when a task subtype is detected. `true` (default) injects the scene
   * reference block; `false` disables it — saves ~200 input tokens per call
   * but loses the subtype-specific role/skeleton guidance.
   */
  sceneRefEnabled: boolean
  /**
   * Task classifier backend (ADR-011): `'heuristic'` (default) wraps the
   * keyword/regex heuristics; `'llm'` is the opt-in service-layer LLM
   * classifier — until the LLM implementation ships, `'llm''` falls back to
   * the heuristic with a warning.
   */
  classifier: 'heuristic' | 'llm'
  /**
   * Local zero-token template render (1.5.6, 方案 A): when the instruction
   * maps to a well-structured subcategory with extractable signals, answer
   * with a locally rendered four-section template — no LLM call, no tokens.
   * `'auto'` (default) renders when the confidence gate passes and falls back
   * to the LLM otherwise; `'on'` renders whenever a subcategory matches;
   * `'off'` disables the local path entirely; `'hybrid'` (1.6.1) renders
   * locally and then checks goal-anchor alignment — aligned results return at
   * zero tokens, misaligned ones go through a cheap LLM refinement
   * (`refined: true`, ~400-800 tokens vs ~1300-2300 for the full pipeline).
   */
  localTemplate: 'auto' | 'on' | 'off' | 'hybrid'
  /**
   * Goal-anchor alignment threshold for `localTemplate: 'hybrid'` (1.6.1):
   * when `goalAnchorsScore(profile)` is below this value the local render is
   * refined by a cheap LLM call; at or above it the result returns as-is at
   * zero tokens. 0.4 = refine only instructions with no goal/constraint/
   * audience anchor at all; 0.8 = refine almost everything.
   */
  hybridAlignThreshold: number
  /**
   * Template set id for the optimizer role documents. `'default'` (the only
   * built-in) uses the shipped skeletons; unknown ids fail the load loudly.
   * Custom skeletons come from `metaPromptTemplate`.
   */
  templateId: string
  /**
   * Optional custom role-document skeletons (partial sets allowed: missing
   * languages fall back to the built-in ones). Each skeleton must keep its
   * data placeholder(s), the `{{输出结构}}` / `{{自查}}` blocks, and the
   * instruction-is-data guardrail line — violations fail the load loudly.
   */
  metaPromptTemplate?: CustomTemplateSet
  /** Optional explicit provider route; provider and model must be set together. */
  provider?: string
  /** Optional explicit model id; provider and model must be set together. */
  model?: string
  /** Stream early-stop: consecutive low-growth chunks threshold (default 16, since 1.4.5). */
  earlyStopTailChunks?: number
  /** Stream early-stop: single chunk growth threshold considered "tail" (default 24, since 1.4.5). */
  earlyStopTailGrowth?: number
  /**
   * Auto-adaptation engine (self-iteration, default off). When enabled, the
   * optimizer tracks usage patterns (episode log) and automatically adjusts
   * profile, local template mode, and temperature based on user behavior.
   * Adaptation kicks in only after `minAdaptEpisodes` (default 10) episodes.
   */
  autoAdapt: boolean
  /** Minimum episodes before adaptation kicks in (avoid small-sample bias). */
  minAdaptEpisodes: number
}

/**
 * Loader schema: validates configuration and fills defaults at plugin load.
 * Invalid configuration fails the load loudly (harness convention).
 */
export const Config: z<Config> = z.object({
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().step(1).min(1).max(128000).default(1200),
  maxRetries: z.number().step(1).min(0).max(5).default(1),
  maxCalls: z.number().step(1).min(1).max(20).default(4),
  maxInputChars: z.number().step(1).min(1).max(100000).default(4000),
  maxInputTokens: z.number().step(1).min(0).max(200000).default(3000),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(60000),
  outputLanguage: z.string().default('auto'),
  outputStyle: z.union(['sections', 'plain', 'role-task-goal']).default('plain'),
  metaPromptLanguage: z.union(['auto', '中文', '英文']).default('auto'),
  autoOptimize: z.boolean().default(false),
  autoOptimizePrefix: z.string().default('/optimize '),
  extraInstructions: z.string(),
  examples: z.array(z.object({
    input: z.string().required(),
    output: z.string().required(),
  })),
  minSectionChars: z.number().step(1).min(0).max(10000).default(10),
  maxTokenRetryFactor: z.number().min(1).max(3).default(1.5),
  maxTokensCap: z.number().step(1).min(1).max(128000).default(8000),
  maxTotalTokens: z.number().step(1).min(0).default(20000),
  retryTemperatureStep: z.number().min(0).max(2).default(0.3),
  skipIfAlreadyOptimized: z.boolean().default(true),
  selfRefine: z.boolean().default(false),
  autoOptimizeAll: z.boolean().default(false),
  hookIncludeOriginal: z.boolean().default(false),
  cacheEnabled: z.boolean().default(true),
  cacheMaxEntries: z.number().step(1).min(0).max(10000).default(200),
  cacheTtlMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(600000),
  cacheFuzzyMatch: z.boolean().default(true),
  cacheFuzzyThreshold: z.number().min(0).max(1).default(0.6),
  senseNeeds: z.boolean().default(false),
  contextAware: z.boolean().default(true),
  contextMaxMessages: z.number().step(1).min(0).max(100).default(10),
  contextMaxTokens: z.number().step(1).min(0).max(200000).default(800),
  outputLengthMaxTokens: z.number().step(1).min(0).max(200000).default(800),
  situationProfileLevel: z.union(['off', 'minimal', 'full']).default('full'),
  goalAlignmentRetry: z.boolean().default(true),
  optimizationProfile: z.union(['balanced', 'fast']).default('balanced'),
  earlyStop: z.boolean().default(false),
  builtinExamples: z.boolean().default(true),
  sceneRefEnabled: z.boolean().default(true),
  classifier: z.union(['heuristic', 'llm']).default('heuristic'),
  localTemplate: z.union(['auto', 'on', 'off', 'hybrid']).default('auto'),
  hybridAlignThreshold: z.number().min(0).max(1).default(0.4),
  templateId: z.string().default('default'),
  metaPromptTemplate: z.object({
    optimizeZh: z.string(),
    optimizeEn: z.string(),
    iterateZh: z.string(),
    iterateEn: z.string(),
  }),
  provider: z.string(),
  model: z.string(),
  earlyStopTailChunks: z.number().step(1).min(1).max(100).default(16),
  earlyStopTailGrowth: z.number().step(1).min(1).max(200).default(24),
  autoAdapt: z.boolean().default(false),
  minAdaptEpisodes: z.number().step(1).min(5).max(100).default(10),
})
