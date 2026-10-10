/**
 * Candidate selection (1.12.0): the optimizer may produce SEVERAL prompts for one
 * instruction and keep the best one.
 *
 * Sampling is stochastic — the same instruction and model yield a good prompt on
 * one draw and a mediocre one on the next — and the plugin used to return whatever
 * the first correctly-shaped draw produced. The 1.11.0 judge turned quality into a
 * number; this module spends it.
 *
 * **Selection ranks, gates decide.** A candidate that fails the deterministic gate
 * is never eligible however well a judge likes it, and one is only preferred over
 * the first draw when it wins by a real margin (`minGain`) — a tie means the extra
 * calls bought nothing. Pure: the model call arrives as an injected `judge` fn.
 * @module select
 */
/**
 * Score range used by the judge protocol (1–5). Kept here so a caller can
 * sanity-check a `score` without importing the judge module.
 */
export declare const SELECT_MIN_SCORE = 1;
export declare const SELECT_MAX_SCORE = 5;
/**
 * How much better than the baseline (candidate 0) another candidate must score
 * before it is adopted. A tie or a marginal win is not worth the extra model
 * calls the alternative cost, and reporting "we picked candidate 3" for a
 * 0.01 difference would be noise dressed as a decision.
 */
export declare const DEFAULT_SELECT_MIN_GAIN = 0.05;
/**
 * Temperature added per additional candidate. Diversity is the whole point of
 * generating more than one candidate, and the harness gives us exactly one
 * knob that reliably changes the draw.
 */
export declare const SELECT_TEMPERATURE_SPREAD = 0.35;
/** Hard ceiling on candidate count (cost bound; also a config bound). */
export declare const SELECT_MAX_CANDIDATES = 5;
/** The judge verdict for one candidate (shape mirrors `JudgeReport`, no text). */
export interface CandidateJudge {
    /** Weighted mean of the dimension scores (1–5), `undefined` when nothing scored. */
    mean?: number;
    /** Normalized 0–1 score, `undefined` when the report was incomplete. */
    normalized?: number;
    /** Whether every applicable dimension was scored exactly once. */
    complete: boolean;
    /** Ids the judge failed to score. */
    missing: string[];
    /** Ids the judge scored that were not applicable (never counted). */
    rejected: string[];
    /** Ids the report scored more than once (the first wins, the rest are dropped). */
    fabricated: string[];
}
/** One candidate prompt handed to the selector. */
export interface Candidate {
    /** Free-form origin label — `'llm'`, `'local'`, or the pipeline's own tag. */
    source: string;
    /** The candidate prompt text. Never persisted by this module. */
    prompt: string;
}
/** Deterministic-gate verdict for one candidate (shape mirrors `EvalDeterministic`). */
export interface CandidateGate {
    /** Whether the candidate passed every structural and expectation check. */
    passed: boolean;
    /** Whether the structural contract (validateOutput) accepted it. */
    valid: boolean;
    /** Structural failure details, absent when the structure passed. */
    structure?: {
        /** Whether the shape looked like content rather than a heading-only skeleton. */
        substantial: boolean;
        /** Whether section headings (any language) were found. */
        hasHeadings: boolean;
        /** Sections whose body was shorter than `minSectionChars`. */
        thin: string[];
    };
    /** `mustInclude` entries that were absent. */
    missingRequired: string[];
    /** `mustNotInclude` entries that were present (injection canaries). */
    leaked: string[];
}
/** One scored candidate. */
export interface CandidateScore {
    /** Position in the candidate list (0 = the baseline draw). */
    index: number;
    /** Origin label, copied from the candidate. */
    source: string;
    /** Length of the candidate prompt in characters (the text itself is not kept). */
    chars: number;
    /** Deterministic gate verdict; `undefined` when the deterministic layer was skipped. */
    gate?: CandidateGate;
    /** Judge verdict; `undefined` when no judge ran (a gate failure, or judge off). */
    judge?: CandidateJudge;
    /**
     * The score used for ranking: the judge's normalized score when a judge ran,
     * else a heuristic structural score. `undefined` means "not scored" — the
     * candidate did not pass the gate, or the judge could not score it. Never
     * 0 for an unscored candidate: a zero would be a measurement we did not make.
     */
    score?: number;
    /** Why the candidate scored nothing (`gate-failed`, `judge-incomplete`, `judge-error`). */
    error?: string;
}
/** Ranked selection result. */
export interface SelectionSummary {
    /** The adopted candidate's index. */
    chosenIndex: number;
    /**
     * Why it was adopted: `baseline` (candidate 0 kept — it was best, or nothing
     * else was eligible), `gain` (another candidate beat it by ≥ `minGain`),
     * `only-eligible` (everything else failed the gate). Stated explicitly so a
     * caller never has to infer a decision from numbers.
     */
    reason: 'baseline' | 'gain' | 'only-eligible';
    /** Every candidate's score, in input order. */
    scores: CandidateScore[];
    /** How many candidates passed the deterministic gate. */
    eligible: number;
    /** The chosen candidate's score, absent when nothing was scored. */
    score?: number;
}
/** The judge callback: scores one candidate prompt, or returns `undefined`. */
export type CandidateJudgeFn = (candidate: Candidate) => Promise<CandidateJudge | undefined>;
/** Options for `selectCandidatePure`. */
export interface SelectOptions {
    /** Minimum gain over candidate 0 required to adopt another candidate. */
    minGain?: number;
    /** Judge callback; absent = structural selection only. */
    judge?: CandidateJudgeFn;
}
/** Deterministic gate callback: one candidate → its verdict. */
export type CandidateGateFn = (candidate: Candidate) => CandidateGate;
/**
 * Structural fallback score, used when no judge runs (`selectJudge: false` or
 * a judge failure): among candidates that passed the same gate, the longer one
 * carries more of the model's output — the cheapest honest tie-break. It is
 * deliberately NOT the model's token count: this layer must stay free, and
 * `scale` maps characters into the same 0–1 band the judge produces so the two
 * are comparable numbers rather than two different units.
 */
export declare function structuralScore(chars: number, scale?: number): number;
/**
 * Rank candidates and pick one. Order of decisions, in this order:
 *
 * 1. Candidate 0 is the baseline. Whatever the reason, if nothing eligible
 *    beats it by `minGain`, it wins — a selection run must never make the
 *    common case worse than not selecting at all.
 * 2. Only gate-passing candidates are eligible.
 * 3. Among eligible candidates the highest score wins; an unscored eligible
 *    candidate (judge failure) is ranked below every scored one but above the
 *    gate failures.
 *
 * @param candidates - candidates in generation order; index 0 is the baseline.
 * @param scores - the same candidates, scored (see `scoreCandidates`).
 */
export declare function selectCandidatePure(candidates: readonly Candidate[], scores: readonly CandidateScore[], options?: SelectOptions): SelectionSummary;
/**
 * Score every candidate: run the deterministic gate first (cheap, offline, and
 * authoritative), then hand the survivors to the judge.
 *
 * A gate failure produces NO score rather than a low one — the same rule the
 * evaluation harness applies, for the same reason: an injection canary that
 * survived must not be tradeable against an otherwise pretty prompt.
 */
export declare function scoreCandidates(candidates: readonly Candidate[], gate: CandidateGateFn, options?: SelectOptions): Promise<CandidateScore[]>;
/**
 * Temperature for candidate `index`: the configured temperature for the
 * baseline draw, growing by {@link SELECT_TEMPERATURE_SPREAD} per candidate so
 * the draws actually differ, clamped to the harness's 0–2 range.
 */
export declare function candidateTemperature(base: number, index: number, max?: number): number;
/** One-line human/metric summary of a selection (`candidates`/`score`/`reason`). */
export declare function formatSelection(summary: SelectionSummary, lang?: 'zh' | 'en'): string;
/** Machine-readable token for `/optimize --stats` (numbers only, no prose). */
export declare function selectionToken(summary: SelectionSummary): string;
