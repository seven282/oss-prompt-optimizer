/**
 * Result, options and template-resolution layer of the optimizer (moved
 * verbatim from `optimizer.ts`, which re-exports the public names).
 *
 * Invariant: what crosses the service boundary is a defensive copy — a
 * caller's mutation of a returned result, cached entry or eval run can never
 * corrupt the stored original.
 *
 * @module optimizer/results
 */
import type { OptimizeErrorCode as OptimizeErrorCodeType } from '../errors.js';
import type { MetaLanguage } from '../meta.js';
import type { EvalRun } from '../eval.js';
import type { SelectionSummary } from '../select.js';
import { type Config as ConfigType } from '../config.js';
import { type TemplateSet } from '../templates.js';
/** Defensive copy of one evaluation run, including its nested results. */
export declare function cloneEvalRun(run: EvalRun): EvalRun;
/** Defensive copy of a result before it enters or leaves the cache, so a
 *  caller's mutation can never corrupt stored entries (nested sections too). */
export declare function cloneOptimizeResult(result: OptimizeResult): OptimizeResult;
/**
 * 造梦模式 (阶段 2A) system block: appended to the meta-prompt when
 * `senseNeeds` is on. It relaxes the strict "output only the prompt" rule for
 * this call and asks for a clearly marked inference appendix AFTER the
 * prompt — deep goal, implicit constraints, quality criteria, likely
 * follow-ups — each labeled as inference, never mixed into the prompt body.
 */
export declare function senseNeedsBlock(metaLanguage: MetaLanguage): string;
/** Reject unknown config keys (a typo is a loud load failure, harness convention). */
export declare function assertConfigKeys(config: ConfigType): void;
/**
 * Resolve the role-document template set from the config: only `'default'`
 * is built-in, and a custom `metaPromptTemplate` (partial sets fall back to
 * the built-ins per language) must pass `validateTemplateSet` — a violation
 * fails the plugin load loudly.
 */
export declare function resolveTemplates(config: ConfigType): TemplateSet;
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
