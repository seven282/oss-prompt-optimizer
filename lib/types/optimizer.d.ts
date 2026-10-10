import { Service, type Context } from '@deepseek-ai/cordis';
import { type Capabilities } from './compat/index.js';
import { Config, type Config as ConfigType } from './config.js';
import { type OptimizeErrorCode as OptimizeErrorCodeType } from './errors.js';
import { type StatusSnapshot } from './status.js';
import { type MetaLanguage } from './meta.js';
import { type RubricDimension } from './judge.js';
import { type EvalComparison, type EvalRun } from './eval.js';
import { type SelectionSummary } from './select.js';
import { type FeedbackLedger } from './feedback.js';
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
    /**
     * Explicit per-candidate sampling temperatures for one best-of-N run
     * (1.12.0 P1-A), used INSTEAD of the derived
     * `base + index·SELECT_TEMPERATURE_SPREAD` ladder. Providing them does not
     * change any rule — the gate, the judge and the `minGain` requirement all
     * still apply — it only lets a caller (a test, or a deployment with its own
     * diversity policy) control where the candidates are sampled from.
     */
    selectTemperatures?: readonly number[];
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
    /**
     * Best-of-N selection outcome (1.12.0 P1-A). Present only when a run
     * generated more than one candidate; absent means the historical
     * single-candidate path, which is not the same thing as "selection ran and
     * candidate 1 won". Carries counts and scores — never judge reasoning, which
     * would quote the prompt.
     */
    selection?: SelectionSummary;
}
/**
 * Provider-reported token usage for ONE optimization run, summed over its
 * model calls (1.10.0). Counts follow the harness `TokenUsage` contract and
 * are DISJOINT: `inputTokens` is uncached input only, cached input arrives
 * separately as `cacheReadTokens` / `cacheWriteTokens` (billed input = the sum
 * of the three). `calls` counts the calls that actually reported usage, so a
 * cache hit or a local zero-token render is `calls: 0` with every count 0 —
 * that is the honest answer, not a missing measurement.
 */
export interface RunUsage {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
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
    /**
     * Provider-reported usage, cumulative over the plugin's lifetime (1.10.0).
     * Before this the plugin only ever showed HEURISTIC estimates; `usageCalls`
     * is what tells the two apart — when it is 0 the provider reported nothing
     * and the `*Tokens` fields above are guesses, when it is > 0 these fields
     * are the real numbers and the guesses are the fallback.
     */
    usageCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    /**
     * Provider-reported usage of the most recent optimization run (`null` when
     * no usage was reported for it). Rides along with `lastRunCalls`, so a run
     * that made 2 calls and reported nothing is distinguishable from one that
     * reported 2 calls' worth of tokens.
     */
    lastRunUsage: RunUsage | null;
    /**
     * The route the most recent run actually called (1.13.0, benchmark checklist
     * item 6). `null` when that run made no model call — a local zero-token
     * render or a cache hit — because keeping the previous model there would
     * attribute it to a run that never used it.
     */
    lastRunRoute: ModelRoute | null;
    /**
     * Best-of-N selection counters (1.12.0 P1-A). `selectRuns` counts runs that
     * generated more than one candidate; `selectGains` counts the subset where a
     * later candidate actually replaced the baseline draw — the ratio is the
     * only honest answer to "is the extra spend buying anything".
     */
    selectRuns: number;
    selectGains: number;
    lastSelectCandidates: number;
    lastSelectChosen: number;
    lastSelectScore: number;
    lastSelectGate: number;
    /**
     * Host feedback signal (1.12.0 P1-B), counts only. `feedbackSessions` is how
     * many sessions were read; the positive/negative tallies are judgments the
     * human filed on assistant messages, and `feedbackBiasApplied` is the
     * temperature delta they produced on the last run.
     */
    feedbackSessions: number;
    feedbackPositive: number;
    feedbackNegative: number;
    feedbackBiasApplied: number;
}
/**
 * The portable form of a resolved route (1.13.0, benchmark checklist item 6):
 * what leaves the plugin through `getStats()` and the lifecycle events.
 * `ReasoningEffortId` is a harness type, and a published `.d.ts` that imported
 * it would make every consumer resolve a host package it may not have — so the
 * reasoning effort travels as a plain string. Read-only by construction: the
 * optimizer always copies, never hands out its own object.
 */
export interface ModelRoute {
    provider: string;
    model: string;
    reasoningEffort?: string;
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
    /**
     * The config object the loader resolved, kept by identity: its eight
     * `volatile()` fields are cosmokit references, and the loader mutates those
     * references in place on a live edit. `liveConfigListener` re-reads them.
     */
    private readonly rawConfig;
    /** Host capability probe result (1.8.2): see compat/capability.ts. */
    private readonly capabilities;
    /**
     * dsh-settings 接入句柄（1.8.0 设置页 / 0.2.0 起走 volatile 热更新）：
     * `null` 表示宿主没有 settings 服务，设置页降级为 `cordis.patch.yml`。
     */
    private settingsPage;
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
    /** Provider-reported usage of the current run (reset with `runCallCount`). */
    private runUsage;
    /**
     * The route the current run actually called (1.13.0), captured at the single
     * place a model call is made (`generateOnce`). Undefined for a run that never
     * reaches the model — which is precisely what keeps a local zero-token render
     * and a cache hit from naming a model they never used.
     */
    private runRoute;
    /** P1（1.8.1）state persistence adapter (noop when persistState off). */
    private readonly persistence;
    /** The resolved judge rubric (1.11.0); construction fails loudly on an unknown override id. */
    private readonly evalRubric;
    /** Evaluation runs, oldest first (capped at `PERSIST_MAX_EVAL_RUNS`). */
    private evalRuns;
    /** The run new evaluations are compared against (`null` until one is recorded). */
    private evalBaseline;
    /**
     * Host feedback ledgers per session (1.12.0 P1-B), newest write wins, capped
     * at `FEEDBACK_MAX_SESSIONS`. Counts only — see `feedback.ts` for what is
     * deliberately never copied.
     */
    private readonly feedbackLedgers;
    /**
     * The last best-of-N outcome (1.12.0 P1-A), for `/optimize --select`. Kept
     * in memory only: it describes one run, and a stale selection report after a
     * restart would be a report about a run nobody can inspect.
     */
    private lastSelection;
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
    /**
     * The model identity of one finished run (1.13.0): the portable route plus
     * the same facts under the OpenTelemetry GenAI attribute names. `undefined`
     * when the run never called a model — a cache hit or a local render emits
     * neither a route nor a GenAI block, because there is no inference to
     * describe and a zero-filled block would invent a span.
     */
    private routeSignal;
    /** Fire `optimize:success` or `optimize:failure` based on the outcome. */
    private emitCompleted;
    /**
     * Fold one provider-reported usage into both the cumulative ledger and the
     * current run's accumulator (1.10.0).
     *
     * Called from `generateOnce`'s cleanup block rather than at a single return
     * site, so a call that ends in a timeout, an abort or a truncation error
     * still contributes whatever the provider reported before the stream died —
     * a cancelled call is precisely the one whose cost you want to see. A call
     * that reports nothing (adapter without usage support) adds nothing and does
     * not increment `usageCalls`, which is what keeps "reported 0 tokens" and
     * "reported nothing" distinguishable.
     */
    private recordUsage;
    /**
     * The judge rubric in effect (resolved at construction from
     * `evalRubric` overrides). Exposed for `/optimize-eval rubric` and tests.
     */
    getEvalRubric(): readonly RubricDimension[];
    /** The cases a run would use, in order (ids only — no instruction text). */
    listEvalCases(options?: {
        all?: boolean;
        maxCases?: number;
    }): {
        id: string;
        core: boolean;
        injection: boolean;
    }[];
    /** Recent evaluation runs, newest first (copies). */
    getEvalRuns(): EvalRun[];
    /** The recorded baseline run, if any (copy). */
    getEvalBaseline(): EvalRun | undefined;
    /**
     * Record the most recent run (or the one matching `label`) as the baseline.
     * Explicit rather than automatic: a regression gate is only meaningful when
     * the reference point is a run the user chose to stand behind.
     */
    setEvalBaseline(label?: string): EvalRun | undefined;
    /** Last run + baseline + their comparison, for status rendering. */
    getEvalSummary(): {
        last: EvalRun | undefined;
        baseline: EvalRun | undefined;
        comparison: EvalComparison | undefined;
    };
    /**
     * The case pool for a run: the built-in golden set, then the deployment's
     * own cases. Ids are de-duplicated (a configured case may deliberately
     * override a golden one by reusing its id).
     *
     * `all` means "every case", so the configured `evalMaxCases` cap does not
     * apply to it: asking for all 14 golden cases and silently receiving 8 of
     * them is not a cap, it is a lie — and it is exactly what the docs promised
     * against before 1.12.1. An EXPLICIT `maxCases` still wins over `all`, so a
     * caller that wants a bounded slice of everything keeps that ability.
     */
    private evalCasePool;
    /** The judge route: an explicit `evalJudgeProvider`/`evalJudgeModel` pair, else the optimizer's. */
    private resolveJudgeRoute;
    /**
     * Run one evaluation: optimize every case, score it, compare against the
     * baseline and record the result.
     *
     * Cost is bounded by `evalMaxCases` (the `core` subset by default) and each
     * case costs one optimization plus — when `evalJudge` is on — one judge
     * call. The whole run's provider-reported usage is folded into the record
     * from the usage ledger, so "what did measuring cost" has an answer.
     */
    runEval(options?: {
        all?: boolean;
        label?: string;
        mine?: boolean;
        maxCases?: number;
        signal?: AbortSignal;
    }): Promise<{
        run: EvalRun;
        comparison: EvalComparison;
    }>;
    /** Optimize + score one case. Never throws: a failure becomes a scored 0 with a reason. */
    private evalOneCase;
    /**
     * The deterministic gate for one candidate (1.12.0 P1-A), in the shape the
     * selector consumes. Built on `checkDeterministic` — the SAME function the
     * evaluation harness uses — so "what selection accepts" and "what the eval
     * harness scores" cannot drift apart.
     */
    private candidateGateFor;
    /**
     * The judge usable for candidate selection: an explicit
     * `evalJudgeProvider`/`evalJudgeModel` pair, else the optimizer's own route.
     * Selection has its OWN switch (`selectJudge`) rather than reusing the
     * evaluation harness's `evalJudge`: turning the harness's judge off is a
     * statement about measuring, and silently turning ranking off with it would
     * make `/optimize` pick a candidate without scoring any of them.
     *
     * Ranking with the model that produced the candidates carries a
     * self-preference bias, which is why a distinct judge route is the
     * documented recommendation rather than the default assumption.
     */
    private judgeRouteForSelection;
    /**
     * Score ONE candidate prompt against the same gates and judge the evaluation
     * harness uses (1.12.0). Extracted from `evalOneCase` so selection and
     * measurement share one implementation, and so the rules are stated once:
     *
     * - the deterministic gate is decided FIRST and is absolute — a broken
     *   candidate (missing expected content, leaked canary) scores nothing;
     * - a gate-passing candidate with NO judge route scores 1, exactly the
     *   pre-1.12 contract for an offline run;
     * - an incomplete judge answer yields `undefined`, never a partial mean;
     * - the judge call is one `generateOnce` at temperature 0.
     *
     * The presence of `judgeRoute` is the only thing that decides whether a judge
     * runs: the two callers resolve it from their OWN switch (`evalJudge` for the
     * harness, `selectJudge` for ranking), so neither feature can silently
     * disable the other's measurement.
     */
    private scoreCandidate;
    /**
     * The host's per-message feedback service, if this deployment has one. Duck
     * typed (no host package is a dependency) and resolved per call: a host that
     * renames or drops the service loses this signal only.
     */
    private messageFeedbackService;
    /** Whether this host can answer feedback reads at all (for status/commands). */
    hasFeedbackService(): boolean;
    /**
     * Refresh one session's feedback ledger when it is stale, and return what is
     * known. Best-effort by contract: a host that never answers, answers with a
     * business rejection (no such session), or throws leaves the previous ledger
     * (or nothing) in place — feedback must never break an optimization.
     */
    private syncFeedback;
    /**
     * Read the host feedback of up to `feedbackScanLimit` recent sessions (for
     * `/optimize --feedback` and `--status`). Explicit sessions are refreshed by
     * request; the rest come from the in-memory ledgers already read.
     */
    scanFeedback(explicit?: readonly string[]): Promise<FeedbackLedger[]>;
    /** Every feedback ledger currently held (copies, for formatting/tests). */
    getFeedbackLedgers(): FeedbackLedger[];
    /**
     * The last best-of-N outcome, formatted for `/optimize --select`. `undefined`
     * when no selection ever ran in this process — a caller must be able to tell
     * "selection is off" from "selection ran and here is what it did".
     */
    selectSummary(lang?: 'zh' | 'en'): string | undefined;
    /** The last selection's raw scores, for tests and structured callers. */
    getLastSelection(): SelectionSummary | undefined;
    /** Format the feedback readback for the command layer. */
    formatFeedbackSignals(lang?: 'zh' | 'en'): string;
    /** Fold every ledger into one for the bias calculation. */
    private aggregateFeedback;
    /** Snapshot of the cumulative usage ledger (for run deltas). */ private usageSnapshot;
    /** Billed input/output tokens consumed since `before` (from the ledger). */
    private usageDelta;
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
     * The feedback temperature bias for one session, read on demand and cached
     * for `FEEDBACK_TTL_MS`. A caller without a session id (the client button
     * path) gets no bias rather than an extrapolation from other sessions.
     */
    private biasForSession;
    /**
     * Best-of-N selection (1.12.0 P1-A): generate `selectCandidates` candidate
     * prompts for ONE instruction and adopt the best.
     *
     * Cost model, stated because it is the whole trade: N candidates cost up to
     * N times the generation calls (the configured `maxCalls` budget applies
     * WITHIN a candidate, so the worst case is N× that), plus one judge call per
     * gate-passing candidate. It is off by default (`selectCandidates: 1`) and
     * the default N is deliberately 3 — enough for the draw to differ, small
     * enough that a failure is affordable.
     *
     * Rules, in order:
     * 1. Every candidate runs the SAME pipeline, at `base + i·0.35` temperature
     *    (clamped to 2). Diversity comes from sampling — no structural variation
     *    is fabricated, because a deliberately hobbled candidate would be a
     *    straw man in the comparison.
     * 2. The deterministic gate decides eligibility FIRST. A candidate that
     *    leaks a canary or misses required content can never win, however well a
     *    judge likes it.
     * 3. `selectJudge: true` ranks survivors with the 1.11.0 judge rubric; off,
     *    or with no judge route, the ranking is the structural heuristic at zero
     *    extra calls.
     * 4. Another candidate replaces candidate 0 only by `selectMinGain` or more.
     *    A tie keeps the baseline, so enabling selection cannot make the common
     *    case worse.
     * 5. Only the winner is cached, and the run reports which candidate it chose
     *    and why — a different candidate is a claim that needs a visible reason.
     */
    private selectBestCandidate;
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
