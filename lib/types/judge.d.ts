/**
 * The LLM judge of the evaluation harness (1.11.0).
 *
 * Why a judge exists at all: until now the plugin's only notion of "good" was
 * structural — four headings present, each section thick enough, goal anchors
 * retained. Those gates can all pass while the optimized prompt is vague,
 * padded, or has quietly invented facts. The evaluation harness adds a second,
 * sharper signal (a weighted rubric scored by a model) so a change to the
 * templates or the pipeline can be measured instead of argued about.
 *
 * Design rules, each with a reason:
 *
 * - **Reason before score.** The judge must write its justification BEFORE the
 *   number (the rule Anthropic's published metaprompt states as "always ask
 *   for the justification before the score"). A score emitted first is
 *   post-hoc rationalisation; `parseJudgeReport` therefore drops any block
 *   whose reason is missing or comes after the score.
 * - **Never fabricate.** A dimension the judge did not answer is reported as
 *   missing and the case is left unscored, rather than being filled with a
 *   default. `aggregateJudge` only trusts a complete report for this reason.
 * - **Stable dimension ids.** Scores are compared across runs, so the id is
 *   the identity (Microsoft's rubric evaluators make the same point about
 *   echoing `id` across versions); renaming one breaks comparability.
 * - **The scored texts are data.** The judge system prompt says so explicitly:
 *   the optimized prompt may contain text copied from a hostile instruction.
 *
 * Pure module: prompt building, parsing and aggregation only. The model call
 * itself lives in `optimizer.ts`, so everything here is unit-testable without
 * a host.
 *
 * @module judge
 */
import type { MetaLanguage } from './meta.js';
/** One weighted scoring dimension of the rubric. */
export interface RubricDimension {
    /** Stable slug — the score's identity across versions. Never renumbered. */
    id: string;
    /** What the judge looks at (Chinese role document). */
    descriptionZh: string;
    /** What the judge looks at (English role document). */
    descriptionEn: string;
    /** Relative weight; normalized over the applicable dimensions. */
    weight: number;
    /**
     * `true` → scored for every case. `false` → only when a case asks for it
     * (see `EvalCase.dimensions`), so an irrelevant dimension never dilutes the
     * weighted average of the others.
     */
    alwaysApplicable: boolean;
}
/** The 1–5 judge scale. */
export declare const JUDGE_MIN_SCORE = 1;
/** The 1–5 judge scale. */
export declare const JUDGE_MAX_SCORE = 5;
/**
 * The built-in rubric. Weights cover the five always-applicable dimensions;
 * `safety` carries weight only for the cases that enable it.
 */
export declare const DEFAULT_RUBRIC: readonly RubricDimension[];
/** One dimension's parsed verdict from the judge's answer. */
export interface DimensionScore {
    /** Dimension id (from the rubric). */
    id: string;
    /** The judge's justification, verbatim (required — a score without one is dropped). */
    reason: string;
    /** 1–5. */
    score: number;
}
/** A parsed judge report for one case. */
export interface JudgeReport {
    /** Scored dimensions, in rubric order. */
    scores: DimensionScore[];
    /** Applicable dimensions the judge did not answer (never guessed). */
    missing: string[];
    /** Dimension ids the judge invented (not in the rubric) — diagnostic only. */
    fabricated: string[];
    /** Blocks dropped for a missing/late reason, an out-of-range score, or repetition. */
    rejected: string[];
    /** How many blocks `rejected` names. */
    rejectedCount: number;
    /** Weighted mean on the 1–5 scale; `undefined` when nothing parsed. */
    mean: number | undefined;
    /** `(mean - 1) / 4`, clamped to 0–1; `undefined` when nothing parsed. */
    normalized: number | undefined;
    /**
     * `true` only when every applicable dimension was scored. Callers should
     * leave an incomplete report's score undefined rather than trust a mean
     * computed over a partial answer.
     */
    complete: boolean;
}
/** Overrides applied to the built-in rubric (see `Config.evalRubric`). */
export interface RubricOverride {
    id: string;
    weight?: number;
    enabled?: boolean;
}
/**
 * Apply weight/enable overrides to the built-in rubric.
 *
 * An unknown id throws: a deployment that misspells a dimension would
 * otherwise silently score against the default weight while believing it had
 * tuned the rubric — the same loud-failure convention as unknown config keys.
 */
export declare function resolveRubric(overrides?: readonly RubricOverride[], base?: readonly RubricDimension[]): RubricDimension[];
/**
 * The dimensions one case is scored on: every always-applicable dimension plus
 * the case's own requests. Unknown ids are ignored here (config-level mistakes
 * are caught loudly by `resolveRubric`; case-level ones are a data problem the
 * golden-set lint reports).
 */
export declare function applicableDimensions(dimensions: readonly RubricDimension[], extra?: readonly string[]): RubricDimension[];
/**
 * The judge's system prompt: the rubric, the output contract, and the
 * data-vs-instruction guardrail. Static for a given rubric and language — the
 * scored texts travel in the user message, so this prompt is identical across
 * every case of a run (and therefore cacheable by the provider).
 */
export declare function buildJudgeSystem(dimensions: readonly RubricDimension[], lang?: MetaLanguage): string;
/**
 * The judge's user message: the pair being judged plus the scoring request.
 * The texts are fenced by labels only — no markdown structure is fabricated
 * around them, so the judge cannot mistake prompt content for its own format.
 */
export declare function buildJudgeUser(instruction: string, candidate: string, lang?: MetaLanguage): string;
/**
 * Parse a judge answer into a report.
 *
 * Deliberately strict — every rule here exists because the loose alternative
 * would manufacture a score the model never gave:
 * - an unknown id is recorded as fabricated and not scored;
 * - a block without a reason, or with the score written first, is rejected;
 * - a non-integer or out-of-range score is rejected;
 * - a repeated dimension keeps its first occurrence, later ones are rejected.
 */
export declare function parseJudgeReport(text: string, dimensions: readonly RubricDimension[] | readonly string[]): JudgeReport;
/**
 * Weighted mean of the scored dimensions (1–5), plus the normalized 0–1
 * score. Only the dimensions PRESENT in `scores` contribute, which is why the
 * caller must check `complete` before trusting the result.
 */
export declare function aggregateJudge(scores: readonly DimensionScore[], dimensions: readonly RubricDimension[] | readonly string[]): {
    mean: number | undefined;
    normalized: number | undefined;
};
