import { Service, type Context } from '@deepseek-ai/cordis'
import {
  BlockAssembler,
  createUserMessage,
  deepFreeze,
  type ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { Config, type Config as ConfigType } from './config.js'
import { OptimizeError, OptimizeErrorCode } from './errors.js'
import type { OptimizeErrorCode as OptimizeErrorCodeType } from './errors.js'
import type { OptimizeMethod } from './events.js'
import { detectLanguage, type MetaLanguage } from './meta.js'
import {
  assertInput,
  estimateTokens,
  hasAllSections,
  hasPlainOutput,
  hasSectionHeadings,
  hasSubstantialContent,
  hasValidSections,
  INCOMPLETE_SECTIONS_MESSAGE,
  plainHeadingsMessage,
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
import { DEFAULT_TEMPLATES, validateTemplateSet, type TemplateSet } from './templates.js'
import { MaxTokensError, assembleStream, finishToError } from './llm.js'
import { buildDiagnosis, refineInstruction } from './diagnose.js'
import { buildIterateSystem, buildOptimizeSystem, type PromptBuildContext } from './prompt.js'
import { createOptimizeCache, fnv1a, type OptimizeCache } from './cache.js'

export { MaxTokensError } from './llm.js'

/** Stable capability-owned timeout reason code for optimization calls. */
export const PROMPT_OPTIMIZER_TIMEOUT_CODE = 'PROMPT_OPTIMIZER_TIMEOUT'

/** Defensive copy of a result before it enters or leaves the cache, so a
 *  caller's mutation can never corrupt stored entries (nested sections too). */
function cloneOptimizeResult(result: OptimizeResult): OptimizeResult {
  return {
    ...result,
    ...(result.sections !== undefined ? { sections: result.sections.map((s) => ({ ...s })) } : {}),
  }
}

/** Complete set of accepted config keys; anything else fails the load loudly. */
const CONFIG_KEYS = new Set([
  'temperature',
  'maxTokens',
  'maxRetries',
  'maxCalls',
  'maxInputChars',
  'maxInputTokens',
  'timeoutMs',
  'outputLanguage',
  'outputStyle',
  'metaPromptLanguage',
  'autoOptimize',
  'autoOptimizePrefix',
  'extraInstructions',
  'examples',
  'minSectionChars',
  'maxTokenRetryFactor',
  'maxTokensCap',
  'retryTemperatureStep',
  'skipIfAlreadyOptimized',
  'selfRefine',
  'autoOptimizeAll',
  'hookIncludeOriginal',
  'cacheEnabled',
  'cacheMaxEntries',
  'cacheTtlMs',
  'contextAware',
  'contextMaxMessages',
  'contextMaxTokens',
  'templateId',
  'metaPromptTemplate',
  'provider',
  'model',
])

/** Reject unknown config keys (a typo is a loud load failure, harness convention). */
function assertConfigKeys(config: ConfigType): void {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`prompt-optimizer: unknown config key "${key}"`)
  }
}

/**
 * Resolve the role-document template set from the config: only `'default'`
 * is built-in, and a custom `metaPromptTemplate` (partial sets fall back to
 * the built-ins per language) must pass `validateTemplateSet` — a violation
 * fails the plugin load loudly.
 */
function resolveTemplates(config: ConfigType): TemplateSet {
  if (config.templateId !== 'default') {
    throw new Error(`prompt-optimizer: unknown templateId "${config.templateId}" (only "default" is built-in)`)
  }
  const custom = config.metaPromptTemplate
  if (custom === undefined) return DEFAULT_TEMPLATES
  const merged: TemplateSet = {
    optimizeZh: custom.optimizeZh ?? DEFAULT_TEMPLATES.optimizeZh,
    optimizeEn: custom.optimizeEn ?? DEFAULT_TEMPLATES.optimizeEn,
    iterateZh: custom.iterateZh ?? DEFAULT_TEMPLATES.iterateZh,
    iterateEn: custom.iterateEn ?? DEFAULT_TEMPLATES.iterateEn,
  }
  validateTemplateSet(merged)
  return merged
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
  /**
   * Optional conversation context (background reference only). The caller
   * gathers and bounds it (e.g. `gatherConversationContext`); the service
   * injects it into the meta-prompt as the `{{上下文信息}}` block. Absent
   * (or empty) keeps the optimizer blind to the conversation.
   */
  context?: string
  /**
   * Optional cache-namespace scope (e.g. a session id). Included in the cache
   * key so cache hits never cross scopes. Absent → a global cache namespace
   * (the key already contains the full request, so identical requests share).
   */
  cacheScope?: string
}

/** The service result: the optimized prompt, or a clear fallback. */
export interface OptimizeResult {
  /** The optimized prompt on success, the original instruction on failure. */
  prompt: string
  /** Whether the four-section validation passed. */
  optimized: boolean
  /** Failure explanation present when `optimized` is false. */
  error?: string
  /** Stable machine-readable error code (present whenever `optimized` is false). */
  errorCode?: OptimizeErrorCodeType
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
  /** The active role-document template set (resolved and validated at construction). */
  private readonly templates: TemplateSet
  /** Runtime override for "optimize every message" (flipped by `/auto-optimize`). */
  private runtimeAutoOptimizeAll = false
  /**
   * Runtime override for the role-document language (flipped by the
   * `/optimizer-language` command and the input-box language button).
   * `undefined` falls back to the configured `metaPromptLanguage`.
   */
  private runtimeMetaPromptLanguage: MetaLanguage | undefined
  /** In-memory validated-result cache (LRU + TTL, see ADR-008). */
  private readonly cache: OptimizeCache<OptimizeResult>
  /** Lightweight run statistics (观测, roadmap 要优化的功能 #2). */
  private readonly stats = {
    runs: 0,
    success: 0,
    failed: 0,
    cached: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    lastOutputTokens: 0,
  }

  constructor(ctx: Context, config: ConfigType) {
    super(ctx, 'promptOptimizer')
    assertConfigKeys(config)
    this.config = config
    this.templates = resolveTemplates(config)
    this.cache = createOptimizeCache<OptimizeResult>({
      maxEntries: config.cacheEnabled ? config.cacheMaxEntries : 0,
      ttlMs: config.cacheTtlMs,
    })
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

  /**
   * The active role-document language mode: runtime override (pinned via
   * `/optimizer-language`), else the configured `metaPromptLanguage`.
   * `'auto'` means each call resolves the language from its input.
   */
  getMetaPromptLanguage(): 'auto' | MetaLanguage {
    return this.runtimeMetaPromptLanguage ?? (this.config.metaPromptLanguage === 'auto' ? 'auto' : this.config.metaPromptLanguage === '英文' ? 'en' : 'zh')
  }

  /** Resolve the role-document language for one call: `'auto'` detects it from `input`. */
  resolveMetaLanguage(input: string): MetaLanguage {
    const language = this.getMetaPromptLanguage()
    return language === 'auto' ? detectLanguage(input) : language
  }

  /** Set the runtime role-document language override; `'auto'` clears it (fall back to config). */
  setMetaPromptLanguage(language: 'auto' | MetaLanguage): void {
    this.runtimeMetaPromptLanguage = language === 'auto' ? undefined : language
  }

  /** Whether context-aware optimization is enabled by config. */
  isContextAware(): boolean {
    return this.config.contextAware
  }

  /** The configured context-gathering bounds (messages / tokens). */
  contextConfig(): { maxMessages: number; maxTokens: number } {
    return { maxMessages: this.config.contextMaxMessages, maxTokens: this.config.contextMaxTokens }
  }

  /** The per-call prompt-build context (config fields + resolved language + optional context). */
  private promptContext(metaLanguage: MetaLanguage, context?: string): PromptBuildContext {
    return {
      outputStyle: this.config.outputStyle,
      extraInstructions: this.config.extraInstructions,
      examples: this.config.examples,
      metaLanguage,
      templates: this.templates,
      context,
    }
  }

  /**
   * Cache key for one request: FNV-1a over what is actually fed to the model
   * (provider + model + the no-diagnosis system prompt + truncated input +
   * truncated context + optional scope). Sampling/budget knobs (temperature,
   * maxTokens…) intentionally do NOT participate — an identical request gets
   * the same validated result regardless of them.
   */
  private cacheKeyFor(
    route: ResolvedRoute,
    system: string,
    input: string,
    context: string | undefined,
    scope: string | undefined,
  ): string {
    return fnv1a([route.provider, route.model, system, input, context ?? '', scope ?? ''].join('\u0000'))
  }

  /** Fire `optimize:start`; a throwing listener must never break the pipeline. */
  private emitStart(method: OptimizeMethod, input: string): void {
    try {
      this.ctx.emit('prompt-optimizer/optimize:start', { method, input })
    } catch {
      // Observers are best-effort; ignore listener failures.
    }
  }

  /** Fire `optimize:success` or `optimize:failure` based on the outcome. */
  private emitCompleted(method: OptimizeMethod, input: string, result: OptimizeResult, durationMs: number): void {
    this.stats.runs++
    if (result.optimized) {
      this.stats.success++
      if (result.outputTokens !== undefined) this.stats.lastOutputTokens = result.outputTokens
    } else {
      this.stats.failed++
    }
    this.stats.totalDurationMs += durationMs
    if (durationMs > this.stats.maxDurationMs) this.stats.maxDurationMs = durationMs
    try {
      this.ctx.emit(
        result.optimized ? 'prompt-optimizer/optimize:success' : 'prompt-optimizer/optimize:failure',
        { method, input, result, durationMs },
      )
    } catch {
      // Observers are best-effort; ignore listener failures.
    }
  }

  /** Snapshot of the run statistics (观测; copy so callers cannot mutate). */
  getStats(): {
    runs: number
    success: number
    failed: number
    cached: number
    totalDurationMs: number
    maxDurationMs: number
    lastOutputTokens: number
  } {
    return { ...this.stats }
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
    try {
      assertInput(rawInput)
    } catch {
      throw new OptimizeError(OptimizeErrorCode.EMPTY_INPUT, 'prompt-optimizer: instruction must be a non-empty string')
    }
    // 方案 B: pass-through only when there is no meaningful NEW conversation
    // context. With a non-empty context the input is re-optimized — the
    // conversation has moved on and the result should reflect it.
    const hasContext = options.context !== undefined && options.context.trim().length > 0
    if (
      this.config.skipIfAlreadyOptimized &&
      this.config.outputStyle === 'sections' &&
      hasAllSections(rawInput) &&
      !hasContext
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
    const metaLanguage = this.resolveMetaLanguage(rawInput)
    const outputLanguage = options.outputLanguage ?? this.config.outputLanguage
    const startedAt = Date.now()
    this.emitStart('optimize', rawInput)
    // Cache (ADR-008): an identical request (route + system + truncated
    // input/context + scope) returns the previous validated result with zero
    // model calls. The route is resolved once here so the pipeline reuses it.
    let preResolvedRoute: ResolvedRoute | undefined
    let cacheKey: string | undefined
    if (this.config.cacheEnabled) {
      preResolvedRoute = this.resolveRoute()
      cacheKey = this.cacheKeyFor(
        preResolvedRoute,
        buildOptimizeSystem(this.promptContext(metaLanguage, options.context), input, outputLanguage),
        input,
        options.context,
        options.cacheScope,
      )
      const hit = this.cache.get(cacheKey)
      if (hit !== undefined) {
        this.stats.cached++
        this.emitCompleted('optimize', rawInput, hit, 0)
        return cloneOptimizeResult(hit)
      }
    }
    const result = await this.runPipeline(
      (outputLanguage, diagnosis) =>
        buildOptimizeSystem(this.promptContext(metaLanguage, options.context), input, outputLanguage, diagnosis),
      rawInput,
      options,
      metaLanguage,
      preResolvedRoute,
    )
    if (result.optimized && cacheKey !== undefined) this.cache.set(cacheKey, cloneOptimizeResult(result))
    this.emitCompleted('optimize', rawInput, result, Date.now() - startedAt)
    return result
  }

  /**
   * Iterate on a previously optimized prompt with a new requirement. Runs the
   * same generation pipeline as `optimize` but frames the model call around
   * the previous result. Never throws for a model-quality failure: the
   * previous result is returned unchanged with an explanation instead.
   */
  async iterate(lastOptimized: string, instruction: string, options: OptimizeOptions = {}): Promise<OptimizeResult> {
    try {
      assertInput(lastOptimized)
    } catch {
      throw new OptimizeError(OptimizeErrorCode.EMPTY_INPUT, 'prompt-optimizer: lastOptimized must be a non-empty string')
    }
    try {
      assertInput(instruction)
    } catch {
      throw new OptimizeError(OptimizeErrorCode.EMPTY_INPUT, 'prompt-optimizer: iteration instruction must be a non-empty string')
    }
    let last = truncateInput(lastOptimized, this.config.maxInputChars)
    last = truncateByTokens(last, this.config.maxInputTokens, (text) => this.estimateInputTokens(text))
    let next = truncateInput(instruction, this.config.maxInputChars)
    next = truncateByTokens(next, this.config.maxInputTokens, (text) => this.estimateInputTokens(text))
    const metaLanguage = this.resolveMetaLanguage(instruction)
    const outputLanguage = options.outputLanguage ?? this.config.outputLanguage
    const startedAt = Date.now()
    this.emitStart('iterate', lastOptimized)
    // Cache (ADR-008): identical iterate requests share the previous result.
    let preResolvedRoute: ResolvedRoute | undefined
    let cacheKey: string | undefined
    if (this.config.cacheEnabled) {
      preResolvedRoute = this.resolveRoute()
      cacheKey = this.cacheKeyFor(
        preResolvedRoute,
        buildIterateSystem(this.promptContext(metaLanguage, options.context), last, next, outputLanguage),
        `${last}\u0000${next}`,
        options.context,
        options.cacheScope,
      )
      const hit = this.cache.get(cacheKey)
      if (hit !== undefined) {
        this.stats.cached++
        this.emitCompleted('iterate', lastOptimized, hit, 0)
        return cloneOptimizeResult(hit)
      }
    }
    const result = await this.runPipeline(
      (outputLanguage, diagnosis) =>
        buildIterateSystem(this.promptContext(metaLanguage, options.context), last, next, outputLanguage, diagnosis),
      lastOptimized,
      options,
      metaLanguage,
      preResolvedRoute,
    )
    if (result.optimized && cacheKey !== undefined) this.cache.set(cacheKey, cloneOptimizeResult(result))
    this.emitCompleted('iterate', lastOptimized, result, Date.now() - startedAt)
    return result
  }

  /**
   * Shared generation pipeline: resolve the route, then retry the model call
   * until the output passes validation or the retry budget is exhausted. A
   * failed run returns `fallbackPrompt` (the raw instruction for `optimize`,
   * the previous result for `iterate`) with an explanation and error code.
   */
  private async runPipeline(
    buildSystem: (outputLanguage: string, diagnosis?: string) => string,
    fallbackPrompt: string,
    options: OptimizeOptions,
    metaLanguage: MetaLanguage,
    route?: ResolvedRoute,
  ): Promise<OptimizeResult> {
    const resolvedRoute = route ?? this.resolveRoute()
    const baseTemperature = options.temperature ?? this.config.temperature
    let effectiveMaxTokens = options.maxTokens ?? this.config.maxTokens
    const outputLanguage = options.outputLanguage ?? this.config.outputLanguage
    let lastError: Error | undefined
    let lastDiagnosis: string | undefined
    // 断点续传: the text accumulated from truncated calls. On `max-tokens`
    // the partial output is kept and the next call CONTINUES from it, so a
    // long optimization does not regenerate what was already produced.
    let resumed = ''
    let attempt = 0
    // Unified call budget (`maxCalls`, roadmap 要优化的功能 #1): the first
    // call plus every expansion and validation retry counts; exceeding it
    // degrades to the fallback with TOO_MANY_CALLS (bounds worst-case cost).
    let callCount = 0
    // The validation retry budget (`maxRetries`) and the max-tokens
    // auto-expansion are independent: a truncated output grows
    // `effectiveMaxTokens` by the factor up to `maxTokensCap` WITHOUT
    // consuming the retry budget (`continue` skips the budget step below),
    // while a validation failure advances `attempt` and stops at `maxRetries`.
    for (;;) {
      options.signal?.throwIfAborted()
      if (callCount >= this.config.maxCalls) {
        lastError = new OptimizeError(
          OptimizeErrorCode.TOO_MANY_CALLS,
          `prompt-optimizer: exceeded the ${this.config.maxCalls}-call budget`,
        )
        break
      }
      const temperature = Math.min(2, baseTemperature + this.config.retryTemperatureStep * attempt)
      try {
        callCount++
        const prompt = await this.generateOnce(
          buildSystem(outputLanguage, attempt > 0 ? lastDiagnosis : undefined),
          resolvedRoute,
          options.signal,
          temperature,
          effectiveMaxTokens,
          resumed.length > 0 ? resumed : undefined,
        )
        const full = resumed.length > 0 ? resumed + prompt : prompt
        const valid = this.config.outputStyle === 'plain'
          ? hasPlainOutput(full, this.config.minSectionChars)
          : this.config.minSectionChars > 0
            ? hasValidSections(full, this.config.minSectionChars)
            : hasAllSections(full)
        if (valid) {
          let result = full
          if (this.config.selfRefine) {
            const refined = await this.refineOnce(full, resolvedRoute, outputLanguage, options.signal, temperature, metaLanguage, options.context)
            if (refined !== undefined) result = refined
          }
          return {
            prompt: result,
            optimized: true,
            retries: attempt,
            outputTokens: this.estimateInputTokens(result),
            ...(this.config.outputStyle === 'sections' ? { sections: this.sectionsOf(result) } : {}),
          }
        }
        const missingSections = this.config.outputStyle !== 'plain' && !hasAllSections(full)
        const failureCode = this.config.outputStyle === 'plain'
          ? hasSectionHeadings(full)
            ? OptimizeErrorCode.HEADINGS_IN_PLAIN
            : OptimizeErrorCode.THIN_OUTPUT
          : missingSections
            ? OptimizeErrorCode.MISSING_SECTIONS
            : OptimizeErrorCode.THIN_SECTIONS
        lastError = new OptimizeError(
          failureCode,
          this.config.outputStyle === 'plain'
            ? hasSectionHeadings(full)
              ? plainHeadingsMessage()
              : thinOutputMessage(this.config.minSectionChars)
            : this.config.minSectionChars > 0
              ? `${INCOMPLETE_SECTIONS_MESSAGE}; ${thinSectionsMessage(this.config.minSectionChars)}`
              : INCOMPLETE_SECTIONS_MESSAGE,
        )
        lastDiagnosis = buildDiagnosis({
          outputStyle: this.config.outputStyle,
          minSectionChars: this.config.minSectionChars,
          language: metaLanguage,
          prompt: full,
          failureCode,
        })
      } catch (error) {
        if (error instanceof MaxTokensError && this.config.maxTokenRetryFactor > 1) {
          // Jump expansion (跳档) + resume (断点续传): grow the effective
          // maxTokens by the factor up to maxTokensCap, keeping the partial
          // text so the next call continues instead of regenerating.
          const next = Math.min(this.config.maxTokensCap, Math.ceil(effectiveMaxTokens * this.config.maxTokenRetryFactor))
          if (next > effectiveMaxTokens) {
            effectiveMaxTokens = next
            resumed = resumed.length > 0 ? resumed + error.partial : error.partial
            lastError = error
            continue
          }
        }
        const timeout = timeoutOf(error as { reason?: unknown }, PROMPT_OPTIMIZER_TIMEOUT_CODE)
        if (timeout !== undefined) {
          throw new OptimizeError(
            OptimizeErrorCode.TIMEOUT,
            `prompt-optimizer: optimization timed out after ${timeout.timeoutMs}ms`,
            { cause: error },
          )
        }
        throw error
      }
      // Only a validation failure reaches here: consume the retry budget.
      attempt++
      if (attempt > this.config.maxRetries) break
    }
    return {
      prompt: fallbackPrompt,
      optimized: false,
      error: lastError?.message,
      errorCode: lastError instanceof OptimizeError ? lastError.code : OptimizeErrorCode.UNKNOWN,
      retries: this.config.maxRetries,
    }
  }

  /**
   * One optional refinement round after a successful optimization
   * (`selfRefine`): re-run the iteration pipeline with the terse-only
   * instruction, then adopt the result only if it still passes validation
   * and is not longer than the original (5% tolerance). Any failure is
   * swallowed — the original result stands.
   */
  private async refineOnce(
    v1: string,
    route: ResolvedRoute,
    outputLanguage: string,
    signal: AbortSignal | undefined,
    temperature: number,
    metaLanguage: MetaLanguage,
    context?: string,
  ): Promise<string | undefined> {
    try {
      const system = buildIterateSystem(
        this.promptContext(metaLanguage, context),
        v1,
        refineInstruction(metaLanguage),
        outputLanguage,
      )
      const v2 = await this.generateOnce(system, route, signal, temperature, this.config.maxTokens)
      const valid = this.config.outputStyle === 'plain'
        ? hasSubstantialContent(v2, this.config.minSectionChars)
        : this.config.minSectionChars > 0
          ? hasValidSections(v2, this.config.minSectionChars)
          : hasAllSections(v2)
      if (!valid) return undefined
      const v2Tokens = this.estimateInputTokens(v2)
      if (v2Tokens > this.estimateInputTokens(v1) * 1.05) return undefined
      return v2
    } catch {
      // Refinement is best-effort: any failure keeps the original result.
      return undefined
    }
  }

  /**
   * One model call: stream with the pre-built system prompt and return the
   * text. With `continueFrom` (断点续传), the user message asks the model to
   * continue from the truncated prefix instead of regenerating it — only the
   * continuation text is returned and the caller merges it.
   */
  private async generateOnce(
    system: string,
    route: ResolvedRoute,
    signal: AbortSignal | undefined,
    temperature: number,
    maxTokens: number,
    continueFrom?: string,
  ): Promise<string> {
    const text = continueFrom !== undefined && continueFrom.length > 0
      ? `以下是已生成的优化提示词（被截断）：\n${continueFrom}\n\n请直接从断点继续输出剩余部分，不要重复或重写已有内容，最后以完整提示词的收尾结束。`
      : '请严格按上述要求，只输出优化后的提示词。'
    const messages = [
      createUserMessage({
        content: [{ type: 'text', text }],
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
      const failure = finishToError(assembler.finish)
      if (failure !== undefined) {
        // Attach the text produced before truncation so the expansion path
        // can resume from it (断点续传).
        if (failure instanceof MaxTokensError) {
          ;(failure as MaxTokensError & { partial: string }).partial = assembleStream(assembler)
        }
        throw failure
      }
      const result = assembleStream(assembler)
      if (result.trim().length === 0) throw new OptimizeError(OptimizeErrorCode.NO_TEXT, 'prompt-optimizer: model produced no text')
      return result
    } finally {
      const dispose = budget[Symbol.dispose]
      if (typeof dispose === 'function') dispose.call(budget)
    }
  }

  /** Resolve the model route: explicit config pair, else the harness default. */
  private resolveRoute(): ResolvedRoute {
    const { provider, model } = this.config
    if (provider !== undefined && model !== undefined) {
      if (provider.length === 0 || model.length === 0) {
        throw new OptimizeError(OptimizeErrorCode.NO_MODEL_ROUTE, 'prompt-optimizer: provider and model must be non-empty strings')
      }
      return { provider, model }
    }
    if (provider !== undefined || model !== undefined) {
      throw new OptimizeError(OptimizeErrorCode.NO_MODEL_ROUTE, 'prompt-optimizer: provider and model must be configured together')
    }
    const selection = this.ctx.get('agentDefaultModel')?.currentSelection()
    if (selection === undefined) {
      throw new OptimizeError(
        OptimizeErrorCode.NO_MODEL_ROUTE,
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
