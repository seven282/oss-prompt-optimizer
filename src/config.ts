import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** One few-shot demonstration injected into the meta-prompt. */
export interface PromptExample {
  /** The raw instruction. */
  input: string
  /** The expected optimized prompt (four sections). */
  output: string
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
  /** When true, the auto-optimize hook optimizes every user text message, not only prefixed ones. */
  autoOptimizeAll: boolean
  /** When true, the hook's replacement message keeps the original instruction text alongside the optimized prompt. */
  hookIncludeOriginal: boolean
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
  autoOptimizeAll: z.boolean().default(false),
  hookIncludeOriginal: z.boolean().default(false),
  provider: z.string(),
  model: z.string(),
})
