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
   * Output style for the optimized prompt. `'plain'` (default) emits a
   * heading-free continuous prompt (fewer tokens); `'sections'` emits the
   * four section headings (## Role / ## Task / ## Context / ## Format).
   */
  outputStyle: 'sections' | 'plain'
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
   * `max-tokens` (a truncated output), consumed from the retry budget.
   * `1` disables the expansion.
   */
  maxTokenRetryFactor: number
  /**
   * Temperature increment applied per retry attempt (bounded by 2), giving
   * retries more diversity. `0` disables the bump.
   */
  retryTemperatureStep: number
  /** When true, an input that already carries the four headings passes through unchanged. */
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
   * The context is truncated to the longest prefix within budget.
   */
  contextMaxTokens: number
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
}

/**
 * Loader schema: validates configuration and fills defaults at plugin load.
 * Invalid configuration fails the load loudly (harness convention).
 */
export const Config: z<Config> = z.object({
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().step(1).min(1).max(128000).default(1200),
  maxRetries: z.number().step(1).min(0).max(5).default(1),
  maxInputChars: z.number().step(1).min(1).max(100000).default(4000),
  maxInputTokens: z.number().step(1).min(0).max(200000).default(3000),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(60000),
  outputLanguage: z.string().default('auto'),
  outputStyle: z.union(['sections', 'plain']).default('plain'),
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
  retryTemperatureStep: z.number().min(0).max(2).default(0.3),
  skipIfAlreadyOptimized: z.boolean().default(false),
  selfRefine: z.boolean().default(false),
  autoOptimizeAll: z.boolean().default(false),
  hookIncludeOriginal: z.boolean().default(false),
  contextAware: z.boolean().default(true),
  contextMaxMessages: z.number().step(1).min(0).max(100).default(6),
  contextMaxTokens: z.number().step(1).min(0).max(200000).default(1500),
  templateId: z.string().default('default'),
  metaPromptTemplate: z.object({
    optimizeZh: z.string(),
    optimizeEn: z.string(),
    iterateZh: z.string(),
    iterateEn: z.string(),
  }),
  provider: z.string(),
  model: z.string(),
})
