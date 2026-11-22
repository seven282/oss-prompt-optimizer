/**
 * Offline meta-optimization advice (P4, 2026-11-22) — the deliberately safe
 * slice of "GEPA-style" reflection that fits this product's privacy stance.
 *
 * GEPA's core signal is `{ score, feedback }`. Here the only `feedback` we are
 * allowed to keep is *numeric and categorical*: rubric dimension scores and
 * error codes. We therefore produce **advice about which rubric dimension to
 * strengthen**, never a rewritten prompt and never a diff — a diff would have
 * to quote the optimized prompt text, which the privacy contract forbids.
 *
 * Opt-in by construction: this module is never called from the optimize hot
 * path. It is exposed only through `/optimize-eval advise`, an explicit
 * offline command, and returns structured counts/categories.
 *
 * @module metaopt
 */
import type { EvalRun } from './eval.js';
/** One structured, text-free advice item. */
export interface MetaAdvice {
    /** Rubric dimension id this advice concerns. */
    dimension: string;
    /** Mean score of the dimension across the given runs (1–5). */
    mean: number;
    /** How many runs contributed a score for this dimension. */
    samples: number;
    /** Coarse category — a label, never a prompt rewrite. */
    category: 'strengthen' | 'maintain' | 'watch';
}
export interface MetaAdviceReport {
    runs: number;
    /** Weakest-first dimension advice (mean ascending). */
    advice: MetaAdvice[];
    /** Aggregate score across runs that have one; undefined when none scored. */
    aggregate: number | undefined;
    /** Total judged cases across runs. */
    scoredCases: number;
}
/**
 * Derive structured advice from recent eval runs.
 *
 * A dimension below `weakThreshold` (default 3 of 5) → `strengthen`; above
 * `strongThreshold` (default 4) → `maintain`; otherwise `watch`. Runs without
 * a per-dimension score contribute nothing — an absent score is never treated
 * as a zero, matching the rest of the eval surface.
 */
export declare function adviseFromRuns(runs: readonly EvalRun[], options?: {
    weakThreshold?: number;
    strongThreshold?: number;
    limit?: number;
}): MetaAdviceReport;
/** Render advice as human text. Only numbers and category labels — no prompt text. */
export declare function formatMetaAdvice(report: MetaAdviceReport, lang?: 'zh' | 'en'): string;
