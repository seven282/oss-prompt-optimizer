import { Service, type Context } from '@deepseek-ai/cordis';
import { type Capabilities } from './compat/index.js';
import { Config, type Config as ConfigType } from './config.js';
import { type OptimizeErrorCode as OptimizeErrorCodeType } from './errors.js';
import { type StatusSnapshot } from './status.js';
import { type MetaLanguage } from './meta.js';
import { type AdaptationHints, type UserOverrides } from './adapt.js';
export { MaxTokensError } from './llm.js';
/** Stable capability-owned timeout reason code for optimization calls. */
export declare const PROMPT_OPTIMIZER_TIMEOUT_CODE = "PROMPT_OPTIMIZER_TIMEOUT";
/** Optional per-call controls (override the plugin config for one call). */
export interface OptimizeOptions {
    /** Cancellation forwarded into the model call. */
    signal?: AbortSignal;
    /** Per-call temperature override. */
    temperature?: number;
    /** Per-call maxTokens override. */
    maxTokens?: number;
    /** Per-call output-language override. */
    outputLanguage?: string;
    /**
     * Optional conversation context (background reference only). The caller
     * gathers and bounds it (e.g. `gatherConversationContext`); the service
     * injects it into the meta-prompt as the `{{上下文信息}}` block. Absent
     * (or empty) keeps the optimizer blind to the conversation.
     */
    context?: string;
    /**
     * Optional cache-namespace scope (e.g. a session id). Included in the cache
     * key so cache hits never cross scopes. Absent → a global cache namespace
     * (the key already contains the full request, so identical requests share).
     */
    cacheScope?: string;
    /**
     * Optional session id (P2 会话级目标注册表): enables the per-session goal
     * registry — goals/constraints stated in earlier calls of the same session
     * carry forward when the current instruction does not restate them
     * (fallback semantics, see `mergeGoals`). The merged goal is injected into
     * the situation block and used by the goal-alignment check. Absent → no
     * registry participation.
     */
    sessionId?: string;
    /**
     * Force a fresh run even when the exact cache would hit (阶段 1B): bypasses
     * both the exact hit and the near-miss warm start. Useful when the user
     * explicitly wants new sensing/creativity instead of the cached result.
     */
    enrich?: boolean;
    /**
     * Per-call override for 需求感应 / 造梦模式 (`senseNeeds`): when true the
     * optimizer also appends a marked `--- 延伸洞察（AI 推断）---` appendix
     * inferring deep goal / implicit constraints / quality criteria / follow-ups.
     */
    senseNeeds?: boolean;
    /**
     * Per-call override for the local zero-token template path (1.5.6).
     * `'off'` (default) forces the LLM pipeline; `'on'` renders locally whenever
     * a subcategory matches; `'hybrid'` (1.6.1) renders locally and refines via
     * a cheap LLM call when the goal-anchor alignment score is below
     * `hybridAlignThreshold`. Absent → the configured `localTemplate` value
     * applies.
     */
    localTemplate?: 'on' | 'off' | 'hybrid';
}
/** The service result: the optimized prompt, or a clear fallback. */
export interface OptimizeResult {
    /** The optimized prompt on success, the original instruction on failure. */
    prompt: string;
    /** Whether the four-section validation passed. */
    optimized: boolean;
    /** Failure explanation present when `optimized` is false. */
    error?: string;
    /** Stable machine-readable error code (present whenever `optimized` is false). */
    errorCode?: OptimizeErrorCodeType;
    /** Attempts consumed before success or giving up (0-based). */
    retries: number;
    /** Per-section breakdown of a successful optimized prompt (sections style only). */
    sections?: {
        name: string;
        content: string;
    }[];
    /** Estimated token count of the optimized prompt (successful results only). */
    outputTokens?: number;
    /** Whether the result came from the local zero-token template path (1.5.6). */
    local?: boolean;
    /**
     * Whether the local render was refined by a cheap LLM call (1.6.1
     * `localTemplate: 'hybrid'` when goal-anchor alignment was low).
     */
    refined?: boolean;
}
/** Run-statistics snapshot (观测; see `getStats`). */
export interface OptimizeStats {
    runs: number;
    success: number;
    failed: number;
    cached: number;
    /** Local zero-token template renders (1.5.6, 观测). */
    local: number;
    /** Local renders refined by a cheap LLM call (1.6.1 `hybrid`, 观测). */
    refined: number;
    totalDurationMs: number;
    maxDurationMs: number;
    lastOutputTokens: number;
    lastCallMs: number;
    avgCallMs: number;
    maxCallMs: number;
    totalCallMs: number;
    callCount: number;
    lastRunCalls: number;
    lastInputTokens: number;
}
/**
 * The `promptOptimizer` service (class-form plugin): optimizes raw
 * instructions into professional four-section prompts through the harness
 * `llm` service, and registers the `prompt_optimize` tool, the `/optimize`
 * command, and the auto-optimize hook. Configuration is validated by the
 * loader; the model route comes from `agentDefaultModel` unless the plugin
 * config supplies an explicit provider/model pair.
 */
export declare class PromptOptimizerService extends Service {
    /**
     * Hard gate: only `llm` is genuinely required — without it there is nothing
     * to optimize with. `tools` / `systemPrompt` / `commands` / `settings` are
     * injected per feature in the constructor (1.8.2), so a service the harness
     * renames disables that one feature instead of preventing the plugin — and
     * thereby the whole `dsh web` process — from loading.
     */
    static inject: string[];
    static Config: import("@deepseek-ai/schemastery").default<Config>;
    private readonly config;
    /** Host capability probe result (1.8.2): see compat/capability.ts. */
    private readonly capabilities;
    /** P0（1.7.8）dsh-settings 可选桥：null 表示宿主无 settings，完全跳过。 */
    private settingsBridge;
    /** P1（1.7.9）最近优化事件（FIFO，供 --status/状态按钮展示）。 */
    private readonly recentEvents;
    /** The active role-document template set (resolved and validated at construction). */
    private readonly templates;
    /** Runtime override for "optimize every message" (flipped by `/auto-optimize`). */
    private runtimeAutoOptimizeAll;
    /**
     * Runtime override for the role-document language (flipped by the
     * `/optimizer-language` command and the input-box language button).
     * `undefined` falls back to the configured `metaPromptLanguage`.
     */
    private runtimeMetaPromptLanguage;
    /** In-memory validated-result cache (LRU + TTL, see ADR-008). */
    private readonly cache;
    /** Episode log for auto-iteration (behavior collection). */
    private readonly episodes;
    /** Layer 3: User overrides (runtime, set via commands). */
    private userOverrides;
    /** Lightweight run statistics (观测, roadmap 要优化的功能 #2). */
    private readonly stats;
    /** Model-call count of the current run (reset by runPipeline). */
    private runCallCount;
    /** P1（1.8.1）state persistence adapter (noop when persistState off). */
    private readonly persistence;
    /** Debounce timer for state persistence. */
    private persistTimer;
    /** Pending state captured at debounce time. */
    private pendingPersist;
    constructor(ctx: Context, config: ConfigType);
    /**
     * Whether the host can assemble a streamed model response. When false,
     * `/optimize` reports `UNSUPPORTED_ENV` instead of fabricating a result.
     */
    canAssembleStream(): boolean;
    /** Capability probe result, exposed for status rendering and tests. */
    hostCapabilities(): Capabilities;
    /**
     * Error raised when the host lacks the exports this operation needs. The
     * message names the missing capability so the failure is actionable without
     * reading the source.
     */
    private unsupportedEnv;
    /**
     * Debounce a state snapshot for persistence (1.8.1). Merges bursts of
     * events into a single write; a disposal flush covers process exit.
     */
    private schedulePersist;
    /** Snapshot the current stats/episodes/events for persistence. */
    private stateSnapshot;
    /** Flush any pending debounced state (disposal / explicit). */
    private flushPersist;
    /** Whether the auto-optimize hook should optimize every user text message. */
    isAutoOptimizeAll(): boolean;
    /** Set the runtime "optimize every message" override. */
    setAutoOptimizeAll(value: boolean): void;
    /**
     * The active role-document language mode: runtime override (pinned via
     * `/optimizer-language`), else the configured `metaPromptLanguage`.
     * `'auto'` means each call resolves the language from its input.
     */
    getMetaPromptLanguage(): 'auto' | MetaLanguage;
    /** Resolve the role-document language for one call: `'auto'` detects it from `input`. */
    resolveMetaLanguage(input: string): MetaLanguage;
    /** Set the runtime role-document language override; `'auto'` clears it (fall back to config). */
    setMetaPromptLanguage(language: 'auto' | MetaLanguage): void;
    /** Whether context-aware optimization is enabled by config. */
    isContextAware(): boolean;
    /** The configured context-gathering bounds (messages / tokens). */
    contextConfig(): {
        maxMessages: number;
        maxTokens: number;
    };
    /**
     * Get early-stop thresholds from config or use defaults.
     */
    private getEarlyStopThresholds;
    /** The per-call prompt-build context (config fields + resolved language + optional context). */
    private promptContext;
    /**
     * Goal-misalignment feedback injected into the next retry's `{{诊断反馈}}`
     * block (situation layer P0). Lists the goal/constraint labels that the
     * output lost, in the role-document language.
     */
    private goalDiagnosis;
    /** Purity-gate diagnosis (1.6.3): the output carried meta/methodology content. */
    private metaContentDiagnosis;
    /** TTL for a session's registered goal (P2 会话级目标注册表). */
    private static readonly GOAL_TTL_MS;
    /** Cap on registered sessions; the oldest entry is evicted beyond it. */
    private static readonly GOAL_REGISTRY_MAX;
    /** Clean interval for expired registry entries (5 minutes). */
    private static readonly GOAL_REGISTRY_CLEAN_INTERVAL;
    /** Last time the registry was cleaned (for periodic cleanup). */
    private lastRegistryClean;
    /**
     * Clean expired entries from the goal registry.
     */
    private cleanExpiredRegistry;
    /** Per-session registered goals: sessionId → goal + last-seen timestamp. */
    private readonly goalRegistry;
    /**
     * Merge the session's registered goal into the current instruction's
     * profile and refresh the registry (P2). Fallback semantics — the current
     * instruction wins whenever it states something; previously-stated goals
     * and constraints carry forward only when the current call leaves them
     * unstated. Expired entries are dropped on access.
     */
    private mergeSessionGoal;
    /**
     * Cache key for one request: FNV-1a over what is actually fed to the model
     * (provider + model + the no-diagnosis system prompt + truncated input +
     * truncated context + optional scope + outputLanguage). Sampling/budget
     * knobs (temperature, maxTokens…) intentionally do NOT participate — an
     * identical request gets the same validated result regardless of them.
     *
     * Fix (#3): outputLanguage now participates in the cache key so that the
     * same instruction with different output languages produces separate cache
     * entries.
     */
    private cacheKeyFor;
    /**
     * 阶段 2A 造梦模式: when `senseNeeds` is on, append the needs-sensing block
     * to the system prompt. The block relaxes the strict "output only the
     * prompt" rule for this call and demands a clearly marked inference appendix.
     */
    private withSenseNeeds;
    /**
     * 阶段 1A 近失配热启动: the best cached validated entry whose instruction
     * matches the current one (identical → score 1; else bigram-Jaccard above
     * `cacheFuzzyThreshold`). The returned entry seeds an `iterate` refinement.
     */
    private fuzzyCandidate;
    /** Fire `optimize:start`; a throwing listener must never break the pipeline. */
    private emitStart;
    /** Fire `optimize:success` or `optimize:failure` based on the outcome. */
    private emitCompleted;
    /** Snapshot of the run statistics (观测; copy so callers cannot mutate). */
    getStats(): OptimizeStats;
    /**
     * Get usage insights from the episode log (auto-iteration, 1.8.0).
     * Returns formatted text for the `/optimize --insights` command.
     */
    getInsights(lang?: 'zh' | 'en'): string;
    /**
     * P1（1.7.9）运行时状态快照：当前生效参数（含来源）、运行统计、偏好模型、
     * 最近事件。供 `/optimize --status` 与客户端状态按钮渲染。
     */
    getStatus(rawInput?: string): StatusSnapshot;
    /**
     * Update feedback for the most recent episode (auto-iteration, 1.8.0).
     * Called by client.js when the user accepts/rejects the optimized result.
     * @param index - Episode index (negative = from end, -1 = most recent)
     * @param accepted - Whether the user used the result
     */
    updateFeedback(index: number, accepted: boolean): void;
    /**
     * Compute adaptation hints based on accumulated episode data.
     * Only active when `autoAdapt: true` and enough episodes exist.
     */
    computeAdaptationHints(): AdaptationHints;
    /** Layer 3: Set a user override for profile/localTemplate/temperature. */
    setUserOverride(key: 'profile' | 'local' | 'temperature', value: string): void;
    /** Layer 3: Clear a user override (revert to config/smart defaults). */
    clearUserOverride(key: 'profile' | 'local' | 'temperature'): void;
    /** Layer 3: Clear all user overrides. */
    clearAllUserOverrides(): void;
    /** Layer 3: Get current user overrides (for display). */
    getUserOverrides(): Readonly<UserOverrides>;
    /** Estimate the token count of one text (harness tokenMeter, heuristic fallback). */
    private estimateTextTokens;
    /** Parse the four sections out of a successful optimized prompt. */
    private sectionsOf;
    /**
     * Resolve effective parameters using 3-layer architecture.
     * Called at the start of optimize() to determine which profile/local/temperature to use.
     *
     * Priority: Layer 3 (user override) > Layer 1 (session learning) > Layer 2 (smart defaults) > base config.
     */
    private resolveEffectiveParams;
    /**
     * Optimize one raw instruction. Never throws for a model-quality failure:
     * when the model cannot produce all four sections within the retry budget,
     * the original instruction is returned with an explanation.
     */
    optimize(rawInput: string, options?: OptimizeOptions): Promise<OptimizeResult>;
    /**
     * Iterate on a previously optimized prompt with a new requirement. Runs the
     * same generation pipeline as `optimize` but frames the model call around
     * the previous result. Never throws for a model-quality failure: the
     * previous result is returned unchanged with an explanation instead.
     */
    iterate(lastOptimized: string, instruction: string, options?: OptimizeOptions): Promise<OptimizeResult>;
    /**
     * Shared generation pipeline: resolve the route, then retry the model call
     * until the output passes validation or the retry budget is exhausted. A
     * failed run returns `fallbackPrompt` (the raw instruction for `optimize`,
     * the previous result for `iterate`) with an explanation and error code.
     */
    private runPipeline;
    /**
     * One optional refinement round after a successful optimization
     * (`selfRefine`): re-run the iteration pipeline with the terse-only
     * instruction, then adopt the result only if it still passes validation
     * and is not longer than the original (5% tolerance). Any failure is
     * swallowed — the original result stands.
     */
    private refineOnce;
    /**
     * One model call: stream with the pre-built system prompt and return the
     * text. With `continueFrom` (断点续传), the user message asks the model to
     * continue from the truncated prefix instead of regenerating it — only the
     * continuation text is returned and the caller merges it.
     */
    /**
     * Seed optimization (1.6.1 hybrid / 1.6.2 auto): a single LLM call turns
     * the locally rendered reference template into a finished prompt against
     * the original instruction — input side stays ~300-500 tokens vs
     * ~1000-1500 for the full pipeline. The extracted goal/constraint/audience
     * anchors are injected (goal-aware), and the output is checked with
     * `goalAlignment` — when anchors are missing and `goalAlignmentRetry` is
     * on, one retry injects the missing anchors as diagnosis. If the call
     * errors or the output fails validation, the seed is returned unchanged
     * so the user still gets a complete four-section result.
     * `stats.refined` is incremented; the caller emits the completion event.
     */
    private refineLocal;
    private generateOnce;
    /** Resolve the model route: explicit config pair, else the harness default. */
    private resolveRoute;
}
export default PromptOptimizerService;
