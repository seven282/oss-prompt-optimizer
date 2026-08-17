import { Service, type Context } from '@deepseek-ai/cordis'
import {
  BlockAssembler,
  createUserMessage,
  deepFreeze,
  type FinishReason,
  type ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { Config, type Config as ConfigType } from './config.js'
import { buildOptimizePrompt } from './meta.js'
import {
  assertInput,
  estimateTokens,
  hasAllSections,
  hasSubstantialContent,
  hasValidSections,
  INCOMPLETE_SECTIONS_MESSAGE,
  REQUIRED_SECTIONS,
  sectionBody,
  thinOutputMessage,
  thinSectionsMessage,
  truncateByTokens,
  truncateInput,
} from './validate.js'
import { registerPromptOptimizeTool } from './tool.js'
import { registerAutoOptimizeHook } from './hook.js'
import { registerOptimizeCommand } from './command.js'

/** Stable capability-owned timeout reason code for optimization calls. */
export const PROMPT_OPTIMIZER_TIMEOUT_CODE = 'PROMPT_OPTIMIZER_TIMEOUT'

/** Raised when a model call stops because the output hit `maxTokens`. */
export class MaxTokensError extends Error {
  constructor() {
    super('prompt-optimizer: model output reached maxTokens')
    this.name = 'MaxTokensError'
  }
}

/** Complete set of accepted config keys; anything else fails the load loudly. */
const CONFIG_KEYS = new Set([
  'temperature',
  'maxTokens',
  'maxRetries',
  'maxInputChars',
  'maxInputTokens',
  'timeoutMs',
  'outputLanguage',
  'outputStyle',
  'autoOptimize',
  'autoOptimizePrefix',
  'extraInstructions',
  'examples',
  'minSectionChars',
  'maxTokenRetryFactor',
  'retryTemperatureStep',
  'skipIfAlreadyOptimized',
  'autoOptimizeAll',
  'hookIncludeOriginal',
  'provider',
  'model',
])

/** Reject unknown config keys (a typo is a loud load failure, harness convention). */
function assertConfigKeys(config: ConfigType): void {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`prompt-optimizer: unknown config key "${key}"`)
  }
}

/** Optional per-call controls (override the plugin config for one call). */
export interface OptimizeOptions {
  /** Cancellation forwarded into the model call. */
  signal?: AbortSignal
  /** Per-call temperature override. */
  temperature?: number
  /** Per-call maxTokens override. */
  maxTokens?: number
  /** Per-call output-language override. */
  outputLanguage?: string
}

/** The service result: the optimized prompt, or a clear fallback. */
export interface OptimizeResult {
  /** The optimized prompt on success, the original instruction on failure. */
  prompt: string
  /** Whether the four-section validation passed. */
  optimized: boolean
  /** Failure explanation present when `optimized` is false. */
  error?: string
  /** Attempts consumed before success or giving up (0-based). */
  retries: number
  /** Per-section breakdown of a successful optimized prompt (sections style only). */
  sections?: { name: string; content: string }[]
  /** Estimated token count of the optimized prompt (successful results only). */
  outputTokens?: number
}

/** Resolved model route for one optimization call. */
interface ResolvedRoute {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
}

/**
 * The `promptOptimizer` service (class-form plugin): optimizes raw
 * instructions into professional four-section prompts through the harness
 * `llm` service, and registers the `prompt_optimize` tool, the `/optimize`
 * command, and the auto-optimize hook. Configuration is validated by the
 * loader; the model route comes from `agentDefaultModel` unless the plugin
 * config supplies an explicit provider/model pair.
 */
export class PromptOptimizerService extends Service {
  static inject = ['llm', 'tools', 'systemPrompt', 'commands']
  static Config = Config

  private readonly config: ConfigType
  /** Runtime override for "optimize every message" (flipped by `/auto-optimize`). */
  private runtimeAutoOptimizeAll = false

  constructor(ctx: Context, config: ConfigType) {
    super(ctx, 'promptOptimizer')
    assertConfigKeys(config)
    this.config = config
    registerPromptOptimizeTool(ctx, config, this)
    registerAutoOptimizeHook(ctx, config, this)
    registerOptimizeCommand(ctx, this)
  }

  /** Whether the auto-optimize hook should optimize every user text message. */
  isAutoOptimizeAll(): boolean {
    return this.config.autoOptimizeAll || this.runtimeAutoOptimizeAll
  }

  /** Set the runtime "optimize every message" override. */
  setAutoOptimizeAll(value: boolean): void {
    this.runtimeAutoOptimizeAll = value
  }

  /** Estimate the token count of one input (harness tokenMeter, heuristic fallback). */
  private estimateInputTokens(text: string): number {
    const meter = this.ctx.get('tokenMeter')
    if (meter !== undefined && typeof (meter as { estimateMessage?: unknown }).estimateMessage === 'function') {
      try {
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'prompt-optimizer' },
        })
        const count = (meter as { estimateMessage: (m: unknown) => number }).estimateMessage(message)
        if (Number.isFinite(count) && count >= 0) return count
      } catch {
        // Fall through to the heuristic.
      }
    }
    return estimateTokens(text)
  }

  /** Parse the four sections out of a successful optimized prompt. */
  private sectionsOf(prompt: string): { name: string; content: string }[] {
    return REQUIRED_SECTIONS.map((name) => ({ name, content: sectionBody(prompt, name) }))
  }

  /**
   * Optimize one raw instruction. Never throws for a model-quality failure:
   * when the model cannot produce all four sections within the retry budget,
   * the original instruction is returned with an explanation.
   */
  async optimize(rawInput: string, options: OptimizeOptions = {}): Promise<OptimizeResult> {
    assertInput(rawInput)
    if (
      this.config.skipIfAlreadyOptimized &&
      this.config.outputStyle === 'sections' &&
      hasAllSections(rawInput)
    ) {
      return {
        prompt: rawInput,
        optimized: true,
        retries: 0,
        sections: this.sectionsOf(rawInput),
        outputTokens: this.estimateInputTokens(rawInput),
      }
    }
    let input = truncateInput(rawInput, this.config.maxInputChars)
    input = truncateByTokens(input, this.config.maxInputTokens, (text) => this.estimateInputTokens(text))
    const route = this.resolveRoute()
    const baseTemperature = options.temperature ?? this.config.temperature
    let effectiveMaxTokens = options.maxTokens ?? this.config.maxTokens
    const outputLanguage = options.outputLanguage ?? this.config.outputLanguage
    let lastError: Error | undefined
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      options.signal?.throwIfAborted()
      const temperature = Math.min(2, baseTemperature + this.config.retryTemperatureStep * attempt)
      try {
        const prompt = await this.generateOnce(
          input,
          route,
          options.signal,
          temperature,
          effectiveMaxTokens,
          outputLanguage,
        )
        const valid = this.config.outputStyle === 'plain'
          ? hasSubstantialContent(prompt, this.config.minSectionChars)
          : this.config.minSectionChars > 0
            ? hasValidSections(prompt, this.config.minSectionChars)
            : hasAllSections(prompt)
        if (valid) {
          return {
            prompt,
            optimized: true,
            retries: attempt,
            outputTokens: this.estimateInputTokens(prompt),
            ...(this.config.outputStyle === 'sections' ? { sections: this.sectionsOf(prompt) } : {}),
          }
        }
        lastError = new Error(
          this.config.outputStyle === 'plain'
            ? thinOutputMessage(this.config.minSectionChars)
            : this.config.minSectionChars > 0
              ? `${INCOMPLETE_SECTIONS_MESSAGE}; ${thinSectionsMessage(this.config.minSectionChars)}`
              : INCOMPLETE_SECTIONS_MESSAGE,
        )
      } catch (error) {
        if (
          error instanceof MaxTokensError &&
          this.config.maxTokenRetryFactor > 1 &&
          attempt < this.config.maxRetries
        ) {
          const next = Math.ceil(effectiveMaxTokens * this.config.maxTokenRetryFactor)
          if (next > effectiveMaxTokens) {
            effectiveMaxTokens = Math.min(128000, next)
            lastError = error
            continue
          }
        }
        throw error
      }
    }
    return {
      prompt: rawInput,
      optimized: false,
      error: lastError?.message,
      retries: this.config.maxRetries,
    }
  }

  /** One model call: assemble the meta-prompt, stream, and return the text. */
  private async generateOnce(
    input: string,
    route: ResolvedRoute,
    signal: AbortSignal | undefined,
    temperature: number,
    maxTokens: number,
    outputLanguage: string,
  ): Promise<string> {
    const system = buildOptimizePrompt(
      input,
      outputLanguage,
      this.config.extraInstructions,
      this.config.examples,
      this.config.outputStyle,
    )
    const messages = [
      createUserMessage({
        content: [{ type: 'text', text: '请严格按上述要求，只输出优化后的提示词。' }],
        source: { kind: 'plugin', plugin: 'prompt-optimizer' },
      }),
    ]
    const budget = deadline(signal, this.config.timeoutMs, PROMPT_OPTIMIZER_TIMEOUT_CODE)
    try {
      const options = deepFreeze({
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}),
        messages,
        system,
        temperature,
        maxTokens,
        signal: budget.signal,
      })
      const assembler = new BlockAssembler()
      for await (const chunk of this.ctx.llm.stream(options)) {
        budget.signal.throwIfAborted()
        assembler.push(chunk)
      }
      budget.signal.throwIfAborted()
      const failure = this.finishError(assembler.finish)
      if (failure !== undefined) throw failure
      const text = assembler
        .blocks()
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (text.trim().length === 0) throw new Error('prompt-optimizer: model produced no text')
      return text
    } finally {
      const dispose = budget[Symbol.dispose]
      if (typeof dispose === 'function') dispose.call(budget)
    }
  }

  /** Translate a terminal finish reason into a thrown error, or accept `stop`. */
  private finishError(finish: FinishReason): Error | undefined {
    const kind = (finish as { kind: string }).kind
    switch (finish.kind) {
      case 'stop':
        return undefined
      case 'error':
      case 'aborted': {
        const error = new Error(`prompt-optimizer: ${finish.failure.message}`)
        Object.assign(error, { code: finish.failure.code })
        return error
      }
      case 'max-tokens':
        return new MaxTokensError()
      case 'tool-calls':
        return new Error('prompt-optimizer: model unexpectedly requested a tool')
      default:
        return new Error(`prompt-optimizer: unsupported finish reason "${kind}"`)
    }
  }

  /** Resolve the model route: explicit config pair, else the harness default. */
  private resolveRoute(): ResolvedRoute {
    const { provider, model } = this.config
    if (provider !== undefined && model !== undefined) {
      if (provider.length === 0 || model.length === 0) {
        throw new Error('prompt-optimizer: provider and model must be non-empty strings')
      }
      return { provider, model }
    }
    if (provider !== undefined || model !== undefined) {
      throw new Error('prompt-optimizer: provider and model must be configured together')
    }
    const selection = this.ctx.get('agentDefaultModel')?.currentSelection()
    if (selection === undefined) {
      throw new Error(
        'prompt-optimizer: no model route; configure provider and model, or mount the agentDefaultModel service',
      )
    }
    return {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
    }
  }
}

export default PromptOptimizerService
