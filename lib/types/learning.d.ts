/**
 * Contextual Thompson Sampling kernel for strategy selection (algorithm
 * adoption P0–P3, 2026-11-22).
 *
 * Design contract — every line here is deliberately shaped by a product
 * constraint:
 *   - **No user text.** The only string that enters is a *bucket key* built
 *     from enumerated task/subtype labels plus a length bucket. No instruction,
 *     no reason, no judge rationale is ever stored. This is what keeps the
 *     privacy promise (`cropEpisodes` strips input) intact.
 *   - **No model call, no new dependency.** Beta sampling uses a deterministic
 *     PRNG derived from a string hash, so a decision is reproducible in a
 *     shadow replay and needs no service.
 *   - **Reward is numeric only.** A missing quality signal produces *no*
 *     observation at all, never a fabricated zero.
 *
 * Arms are `profile × local` (6, not the 9 sketched in the proposal: the
 * runtime config only has `balanced | fast`). Temperature stays rule-based —
 * a continuous dimension would explode the bucket count; the bandit may only
 * choose from a finite set of strategies.
 *
 * @module learning
 */
/** The three learning switches. `off` is the default — zero behaviour change. */
export type LearningMode = 'off' | 'shadow' | 'active';
/** The two runtime profiles the config actually supports. */
export type LearningProfile = 'balanced' | 'fast';
/** The three local-template modes the config actually supports. */
export type LearningLocal = 'on' | 'off' | 'hybrid';
/** One selectable strategy (arm). */
export interface Arm {
    profile: LearningProfile;
    local: LearningLocal;
}
/** All six arms, in a stable order — the index seeds deterministic sampling. */
export declare const ARMS: readonly Arm[];
/** Stable arm identifier used as a state key and in logged events. */
export declare function armKey(arm: Arm): string;
/**
 * P3 reuse #1 — candidate temperature ladder. An arm's `profile` dimension
 * carries a small, deliberately conservative bias: `fast` leans slightly colder,
 * `balanced` slightly warmer. It is an *additive* bias on the existing ladder,
 * never a replacement: `candidateTemperature(base + bias, index)` keeps the
 * spread and the gate/judge rules untouched. The magnitude (0.05) is far below
 * the 0.35 candidate spread, so a wrong arm cannot flatten diversity.
 */
export declare function armTemperatureBias(arm: Arm): number;
/** Clamp a temperature into the harness's 0–2 range (same as candidateTemperature). */
export declare function clampTemperature(value: number, max?: number): number;
/** Parse an arm id back into an arm; `undefined` for anything unknown. */
export declare function parseArm(key: string): Arm | undefined;
/** Coarse input-length buckets — short ≤16, long >200, everything else mid. */
export type LengthBucket = 'short' | 'mid' | 'long';
export declare function lengthBucketOf(chars: number): LengthBucket;
/**
 * Context bucket key: `taskType|subtype|lengthBucket`. All three components
 * are enumerated/labelled data already present in `Episode`; nothing here is
 * derived from the instruction's wording.
 */
export declare function bucketOf(taskType: string, subtype: string | undefined, inputChars: number): string;
/**
 * Reward in [0,1]: quality minus a token cost and a latency cost.
 * `quality === undefined` returns `undefined` — no signal means no observation
 * (an absent reward must never be recorded as a zero, exactly as an unjudged
 * eval case keeps `score` undefined).
 */
export declare function rewardOf(quality: number | undefined, outputTokens: number, durationMs: number): number | undefined;
/** Per-(bucket, arm) posterior summary. `n` is the observation count. */
export interface BetaStat {
    alpha: number;
    beta: number;
    n: number;
    /** Last observation time — used for bounded eviction. */
    ts: number;
}
/** The persisted learning state: a plain, JSON-safe object. */
export interface LearningState {
    version: 1;
    /** bucket key → arm key → posterior. */
    buckets: Record<string, Record<string, BetaStat>>;
    updatedAt: number;
}
/** Upper bound on buckets kept in memory and on disk. */
export declare const LEARNING_MAX_BUCKETS = 128;
/**
 * Percentage of traffic the active policy may touch, chosen by a stable hash
 * of `bucket|input`. 10% keeps the rollout small and keeps a same-input retry
 * in the same arm — the deterministic control group needed for an honest
 * shadow-vs-active comparison.
 */
export declare const ACTIVE_SLICE_PERCENT = 10;
export declare function createLearningState(): LearningState;
/** Parse an untrusted state object; a malformed document yields a fresh state. */
export declare function parseLearningState(raw: unknown): LearningState;
/** Bounded copy — keeps at most `LEARNING_MAX_BUCKETS` buckets. */
export declare function boundLearningState(state: LearningState, max?: number): void;
/** Posterior mean of one posterior. */
export declare function posteriorMean(stat: BetaStat): number;
/**
 * Fold one observation into the state (mutating). A fractional reward in
 * [0,1] is added as `alpha += reward, beta += 1 - reward`, which keeps the
 * posterior in the Beta family without needing a binary outcome.
 */
export declare function observe(state: LearningState, bucket: string, arm: Arm, reward: number, now?: number): void;
/**
 * Pull every posterior toward the prior by `factor` (0 = no decay, 1 = full
 * reset). Called once on load with a half-life, so a model generation change
 * eventually forgets stale decisions.
 */
export declare function decayLearningState(state: LearningState, factor: number, now?: number): void;
/** Half-life decay applied at load time (30 days, matching the proposal). */
export declare const LEARNING_HALF_LIFE_MS: number;
export declare function loadLearningState(raw: unknown, now?: number): LearningState;
/** FNV-1a over a decision key — a tiny, stable hash (no crypto dependency). */
export declare function hash32(text: string): number;
/** One Beta draw from a posterior. */
export declare function betaSample(stat: BetaStat, random: () => number): number;
/** Result of one policy decision. */
export interface BanditDecision {
    arm: Arm;
    /** The arm's stable key, for episode/event logging. */
    armKey: string;
    /**
     * Probability the policy assigned this arm — logged so the shadow period
     * can be evaluated offline with inverse-propensity weighting. Bandit
     * adaptation breaks a plain t-test; this field is what makes an honest
     * comparison possible at all.
     */
    propensity: number;
    /** True when the arm came from the exploration floor, not the posterior. */
    exploration: boolean;
    /** True when the bucket was still in its warmup regime. */
    warmup: boolean;
}
export interface DecideOptions {
    /** Probability of a uniform random draw; default 0.1. */
    exploreFloor: number;
    /** Buckets with fewer observations than this use a deterministic hash. */
    warmupObservations: number;
    /** Seed for the deterministic PRNG; callers pass a stable per-run key. */
    seed: string;
}
export declare const DEFAULT_DECIDE_OPTIONS: DecideOptions;
/** Total observation count across all arms of one bucket. */
export declare function bucketObservations(state: LearningState, bucket: string): number;
/**
 * Choose an arm for a context bucket.
 *
 * Warmup (bucket-level, *not* per-arm — six arms × 50 each would take 300
 * observations to leave cold start): a deterministic hash of `seed|bucket`
 * picks the arm, propensity 1. After warmup: Thompson sampling with an
 * exploration floor. The propensity is estimated with a fixed number of
 * replay draws so it is reproducible and cheap (no closed form exists for a
 * mixture of a uniform and a Beta-argmax policy).
 */
export declare function decide(state: LearningState, bucket: string, options?: DecideOptions): BanditDecision;
/**
 * Offline full-information warmup (OrcaRouter style, miniaturised): seed a
 * bucket's posteriors from precomputed golden-set scores. `score` is in [0,1].
 * No model call happens here — the caller supplies the scores.
 */
export declare function warmupFromScores(state: LearningState, bucket: string, arm: Arm, scores: readonly number[]): void;
