/**
 * The evaluation harness (1.11.0).
 *
 * The plugin could always assert SHAPE but never MEASURE quality, so every "did
 * this edit help?" was an argument. This module turns it into a number comparable
 * across runs, in three layers, cheapest first: `checkDeterministic` (free and
 * offline — the structural gate imported from `validate.ts`, plus per-case
 * substring expectations, which is what makes an injection canary checkable),
 * `judge.ts` (a weighted rubric scored by a model, opt out with `evalJudge:
 * false`), and `mineSessionInstructions` (the host's own session history).
 * Privacy: pure and stateless — instruction text lives in memory for the run
 * only, and `CaseResult` records LENGTHS and scores, never the text.
 *
 * @module eval
 */
import { hasAllSections } from './validate.js';
import type { EvalCaseConfig } from './config.js';
import type { JudgeReport } from './judge.js';
/** Output style of the run being scored (mirrors `Config.outputStyle`). */
export type EvalOutputStyle = 'sections' | 'plain' | 'role-task-goal';
/** One evaluation case: an instruction plus how to score its optimization. */
export interface EvalCase {
    /** Stable id, echoed in every report. */
    id: string;
    /** The raw instruction handed to the optimizer. */
    instruction: string;
    /** Extra rubric dimension ids this case enables. */
    dimensions?: string[];
    /** Substrings the optimized prompt MUST contain. */
    mustInclude?: string[];
    /** Substrings it must NOT contain (injection canaries for adversarial cases). */
    mustNotInclude?: string[];
    /** Marks an injection probe (reported as its own line). */
    injection?: boolean;
    /**
     * `true` → part of the default (`evalMaxCases`-bounded) subset. The default
     * subset is defined by this flag rather than by position so that adding a
     * case never silently changes what a default run measures.
     */
    core?: boolean;
    /**
     * A known-good optimization, used ONLY for offline grader calibration
     * (`pnpm preflight` P10): the deterministic layer must accept it. Never sent
     * to a model.
     */
    referenceGood?: string;
    /**
     * A known-bad optimization, used only for calibration: the deterministic
     * layer must reject it. Defaults to `WEAK_REFERENCE`.
     */
    referenceBad?: string;
}
/**
 * A deliberately weak "optimization": an assistant pleasantry with no sections
 * and no content. Any case scored in sections mode must reject it, which is
 * what makes it useful as the shared negative control.
 */
export declare const WEAK_REFERENCE = "\u597D\u7684\uFF0C\u6211\u6765\u5E2E\u4F60\u5B8C\u6210\u8FD9\u4E2A\u4EFB\u52A1\u3002";
/**
 * The built-in golden set: the task types the plugin claims to serve, one case
 * each, plus the three shapes that break naive graders — a vague instruction,
 * an instruction that is already optimized, and an injection probe.
 *
 * `core: true` marks the default subset (8 cases ≈ 8 optimizer runs + 8 judge
 * calls). The rest only run with `--all`.
 */
export declare const GOLDEN_SET: readonly EvalCase[];
/** Deterministic layer result for one case. */
export interface DeterministicResult {
    /** The structural gate the pipeline itself enforces. */
    structural: boolean;
    /** Every `mustInclude` present and no `mustNotInclude` leaked. */
    expectations: boolean;
    /** Required substrings that are absent. */
    missingRequired: string[];
    /** Forbidden substrings that ARE present (an injection that got through). */
    leaked: string[];
    /** Characters in the scored prompt (the text itself is never stored). */
    outputChars: number;
    /** Heuristic token estimate of the scored prompt. */
    outputTokens: number;
}
/** Score one candidate against the deterministic layer. Pure function. */
export declare function checkDeterministic(item: Pick<EvalCase, 'mustInclude' | 'mustNotInclude'>, candidate: string, outputStyle: EvalOutputStyle, minSectionChars: number): DeterministicResult;
/**
 * The gate a case must clear before its judged score counts: a prompt that
 * fails the structural contract or leaks an injected canary is not "0.8
 * quality", it is broken, and averaging it in would hide that behind a
 * respectable mean.
 */
export declare function deterministicPasses(result: DeterministicResult): boolean;
/** The deterministic-only calibration gate used by preflight (sections mode). */
export declare function calibratesAsExpected(item: Pick<EvalCase, 'mustInclude' | 'mustNotInclude'>, candidate: string, minSectionChars: number): boolean;
/** One case's result inside a run. Contains no instruction text (privacy). */
export interface CaseResult {
    id: string;
    /** Length of the instruction, not the instruction (privacy crop). */
    instructionChars: number;
    deterministic: DeterministicResult;
    /** Present only when the judge ran and answered completely. */
    judge?: JudgeReport;
    /** 0–1: the judged score when available, else the deterministic gate as 0/1. */
    score: number | undefined;
    /** Why the case has no score (optimizer failure, incomplete judge answer). */
    error?: string;
}
/** One evaluation run over a set of cases. */
export interface EvalRun {
    ts: number;
    /** Optional user label (`/optimize-eval run <label>`). */
    label?: string;
    /** Total cases attempted. */
    cases: number;
    /** Cases the optimizer returned a result for. */
    optimized: number;
    /** Cases that cleared the deterministic gate. */
    deterministicPass: number;
    /** Cases with a usable judged score. */
    scored: number;
    /** Injection probes among the cases, and how many leaked a canary. */
    injectionCases: number;
    leaked: number;
    /** Mean of the case scores (0–1); `undefined` when nothing scored. */
    aggregate: number | undefined;
    /** Deterministic gate pass rate over attempted cases (always defined). */
    deterministicPassRate: number;
    /** Mean 1–5 score per rubric dimension (only where judged). */
    perDimension: Record<string, number>;
    /** Cumulative billed input tokens of the run, from the usage ledger. */
    billedInputTokens: number;
    /** Cumulative output tokens of the run. */
    outputTokens: number;
    /** Judge model id, when the judge ran. */
    judgeModel?: string;
    /** Optimizer model id. */
    optimizerModel?: string;
    /** Whether the case set was extended from session history. */
    mined: boolean;
    results: CaseResult[];
}
/** Compare a run against the stored baseline. */
export interface EvalComparison {
    baseline: number | undefined;
    current: number | undefined;
    delta: number | undefined;
    /** The pass threshold the comparison was made against (echoed for display). */
    threshold: number;
    /** `no-baseline` | `no-score` | `pass` | `below-threshold` | `regress`. */
    verdict: 'no-baseline' | 'no-score' | 'pass' | 'below-threshold' | 'regress';
}
/**
 * Compare the current aggregate against the baseline.
 *
 * Regression is checked first: a run that dropped below the baseline is worse
 * than before regardless of where the absolute threshold sits, and reporting
 * "below threshold" for it would hide the direction of travel.
 */
export declare function compareToBaseline(current: number | undefined, baseline: number | undefined, tolerance: number, threshold: number): EvalComparison;
/** Aggregate case results into a run record. Pure function. */
export declare function buildRun(results: readonly CaseResult[], cases: readonly EvalCase[], meta: {
    label?: string;
    judgeModel?: string;
    optimizerModel?: string;
    mined?: boolean;
    ts?: number;
}): EvalRun;
/** Merge the run-wide usage ledger into a finished run. Pure function. */
export declare function withUsage(run: EvalRun, usage: {
    billedInputTokens: number;
    outputTokens: number;
}): EvalRun;
/** Select the cases a run will use: `core` unless `all`, capped by `maxCases`. */
export declare function selectCases(cases: readonly EvalCase[], options?: {
    all?: boolean;
    maxCases?: number;
}): EvalCase[];
/**
 * Map a deployment's configured cases onto runtime cases, assigning stable
 * ids (`user-1`, `user-2`, …) when none is given so a report can always name
 * the case that regressed.
 */
export declare function fromConfig(cases: readonly EvalCaseConfig[]): EvalCase[];
/** Format one run's summary block. */
export declare function formatEvalRun(run: EvalRun, lang?: 'zh' | 'en'): string;
/** Format the baseline comparison block. */
export declare function formatEvalComparison(comparison: EvalComparison, lang?: 'zh' | 'en'): string;
/** Machine-readable verdict token for the client/command layer. */
export declare function evalVerdictToken(run: EvalRun, comparison: EvalComparison): string;
/** Shape of the session-search engine as this module uses it (duck-typed). */
export interface SessionSearchLike {
    searchSessions?: (request: {
        query: string;
        limit?: number;
    }) => Promise<{
        items?: readonly {
            bestMatch?: {
                snippet?: string;
            };
        }[];
    }>;
}
/** Queries sent to the session history, one per task type the plugin serves. */
export declare const MINING_QUERIES: readonly string[];
/**
 * Extract candidate instructions from a snippet returned by the session search.
 *
 * A snippet is an excerpt around a full-text match, not a clean instruction, so
 * this is deliberately conservative — it strips the structural markers of
 * already-optimized or assistant text and rejects anything that is not
 * plausibly a user instruction. Pure function, so the filter is testable
 * without a host.
 */
export declare function cleanMinedSnippet(snippet: string, maxChars?: number): string | undefined;
/**
 * Best-effort mining of real instructions from this host's session history.
 *
 * Every failure mode degrades to "no mined samples": the service may be
 * absent, `searchSessions` may not exist, the call may throw, or the request
 * shape may differ. Mining is a convenience, never a prerequisite for a run,
 * and it must not be the reason `/optimize-eval` fails.
 */
export declare function mineSessionInstructions(engine: SessionSearchLike | undefined, options?: {
    limit?: number;
    signal?: AbortSignal;
    queries?: readonly string[];
}): Promise<string[]>;
/** Re-export for callers that only need the structural gate. */
export { hasAllSections };
