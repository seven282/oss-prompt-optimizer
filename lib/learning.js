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
/** All six arms, in a stable order — the index seeds deterministic sampling. */
export const ARMS = [
    { profile: 'fast', local: 'off' },
    { profile: 'fast', local: 'hybrid' },
    { profile: 'fast', local: 'on' },
    { profile: 'balanced', local: 'off' },
    { profile: 'balanced', local: 'hybrid' },
    { profile: 'balanced', local: 'on' },
];
/** Stable arm identifier used as a state key and in logged events. */
export function armKey(arm) {
    return `${arm.profile}:${arm.local}`;
}
/**
 * P3 reuse #1 — candidate temperature ladder. An arm's `profile` dimension
 * carries a small, deliberately conservative bias: `fast` leans slightly colder,
 * `balanced` slightly warmer. It is an *additive* bias on the existing ladder,
 * never a replacement: `candidateTemperature(base + bias, index)` keeps the
 * spread and the gate/judge rules untouched. The magnitude (0.05) is far below
 * the 0.35 candidate spread, so a wrong arm cannot flatten diversity.
 */
export function armTemperatureBias(arm) {
    return arm.profile === 'fast' ? -0.05 : 0.05;
}
/** Clamp a temperature into the harness's 0–2 range (same as candidateTemperature). */
export function clampTemperature(value, max = 2) {
    return Math.min(max, Math.max(0, Math.round(value * 1000) / 1000));
}
/** Parse an arm id back into an arm; `undefined` for anything unknown. */
export function parseArm(key) {
    return ARMS.find((arm) => armKey(arm) === key);
}
export function lengthBucketOf(chars) {
    if (chars <= 16)
        return 'short';
    if (chars > 200)
        return 'long';
    return 'mid';
}
/**
 * Context bucket key: `taskType|subtype|lengthBucket`. All three components
 * are enumerated/labelled data already present in `Episode`; nothing here is
 * derived from the instruction's wording.
 */
export function bucketOf(taskType, subtype, inputChars) {
    return `${taskType}|${subtype ?? 'none'}|${lengthBucketOf(inputChars)}`;
}
/**
 * Reward in [0,1]: quality minus a token cost and a latency cost.
 * `quality === undefined` returns `undefined` — no signal means no observation
 * (an absent reward must never be recorded as a zero, exactly as an unjudged
 * eval case keeps `score` undefined).
 */
export function rewardOf(quality, outputTokens, durationMs) {
    if (quality === undefined)
        return undefined;
    const cost = 0.3 * (Math.max(0, outputTokens) / 1000);
    const latency = 0.2 * (Math.max(0, durationMs) / 10000);
    const raw = quality - cost - latency;
    return Math.round(Math.min(1, Math.max(0, raw)) * 10000) / 10000;
}
/** Upper bound on buckets kept in memory and on disk. */
export const LEARNING_MAX_BUCKETS = 128;
/**
 * Percentage of traffic the active policy may touch, chosen by a stable hash
 * of `bucket|input`. 10% keeps the rollout small and keeps a same-input retry
 * in the same arm — the deterministic control group needed for an honest
 * shadow-vs-active comparison.
 */
export const ACTIVE_SLICE_PERCENT = 10;
/** Posterior mean pulled back toward this prior on decay. */
const PRIOR = 1;
export function createLearningState() {
    return { version: 1, buckets: {}, updatedAt: 0 };
}
/** Parse an untrusted state object; a malformed document yields a fresh state. */
export function parseLearningState(raw) {
    if (raw === null || typeof raw !== 'object')
        return createLearningState();
    const candidate = raw;
    if (candidate.version !== 1 || candidate.buckets === null || typeof candidate.buckets !== 'object') {
        return createLearningState();
    }
    const buckets = {};
    for (const [bucket, arms] of Object.entries(candidate.buckets ?? {})) {
        if (arms === null || typeof arms !== 'object')
            continue;
        const clean = {};
        for (const [key, stat] of Object.entries(arms)) {
            if (parseArm(key) === undefined || stat === null || typeof stat !== 'object')
                continue;
            const alpha = stat.alpha;
            const beta = stat.beta;
            const n = stat.n;
            if (![alpha, beta, n].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0))
                continue;
            clean[key] = {
                alpha: Math.max(PRIOR, alpha),
                beta: Math.max(PRIOR, beta),
                n,
                ts: typeof stat.ts === 'number' ? stat.ts : 0,
            };
        }
        if (Object.keys(clean).length > 0)
            buckets[bucket] = clean;
    }
    return {
        version: 1,
        buckets,
        updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : 0,
    };
}
/** Bounded copy — keeps at most `LEARNING_MAX_BUCKETS` buckets. */
export function boundLearningState(state, max = LEARNING_MAX_BUCKETS) {
    const keys = Object.keys(state.buckets);
    if (keys.length <= max)
        return;
    const stale = keys
        .map((key) => ({ key, ts: Math.min(...Object.values(state.buckets[key] ?? {}).map((s) => s.ts)) }))
        .sort((a, b) => a.ts - b.ts);
    for (const entry of stale.slice(0, keys.length - max)) {
        delete state.buckets[entry.key];
    }
}
/** Posterior mean of one posterior. */
export function posteriorMean(stat) {
    return stat.alpha / (stat.alpha + stat.beta);
}
/**
 * Fold one observation into the state (mutating). A fractional reward in
 * [0,1] is added as `alpha += reward, beta += 1 - reward`, which keeps the
 * posterior in the Beta family without needing a binary outcome.
 */
export function observe(state, bucket, arm, reward, now = Date.now()) {
    const value = Math.min(1, Math.max(0, reward));
    const arms = state.buckets[bucket] ?? {};
    const key = armKey(arm);
    const current = arms[key] ?? { alpha: PRIOR, beta: PRIOR, n: 0, ts: now };
    arms[key] = {
        alpha: current.alpha + value,
        beta: current.beta + (1 - value),
        n: current.n + 1,
        ts: now,
    };
    state.buckets[bucket] = arms;
    state.updatedAt = now;
    boundLearningState(state);
}
/**
 * Pull every posterior toward the prior by `factor` (0 = no decay, 1 = full
 * reset). Called once on load with a half-life, so a model generation change
 * eventually forgets stale decisions.
 */
export function decayLearningState(state, factor, now = Date.now()) {
    const f = Math.min(1, Math.max(0, factor));
    for (const arms of Object.values(state.buckets)) {
        for (const [key, stat] of Object.entries(arms)) {
            arms[key] = {
                alpha: PRIOR + (stat.alpha - PRIOR) * (1 - f),
                beta: PRIOR + (stat.beta - PRIOR) * (1 - f),
                n: stat.n * (1 - f),
                ts: stat.ts,
            };
        }
    }
    state.updatedAt = now;
}
/** Half-life decay applied at load time (30 days, matching the proposal). */
export const LEARNING_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
export function loadLearningState(raw, now = Date.now()) {
    const state = parseLearningState(raw);
    if (state.updatedAt > 0 && now > state.updatedAt) {
        const halfLives = (now - state.updatedAt) / LEARNING_HALF_LIFE_MS;
        if (halfLives > 0)
            decayLearningState(state, 1 - Math.pow(0.5, halfLives), now);
    }
    return state;
}
/** FNV-1a over a decision key — a tiny, stable hash (no crypto dependency). */
export function hash32(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}
/** `mulberry32`: a deterministic PRNG so a shadow run can be replayed. */
function prng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** Marsaglia–Tsang gamma sample, shape ≥ 1 (our posteriors always are). */
function gammaSample(shape, random) {
    if (shape < 1) {
        // Boost: Gamma(a,b) = Gamma(a+1,b) * U^(1/a). Kept for completeness even
        // though a decayed posterior never drops below the prior of 1.
        return gammaSample(shape + 1, random) * Math.pow(Math.max(random(), 1e-12), 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
        let x = 0;
        let v = 0;
        do {
            // Box–Muller normal, one draw at a time from the same seeded stream.
            const u1 = Math.max(random(), 1e-12);
            const u2 = random();
            x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
            v = 1 + c * x;
        } while (v <= 0);
        v = v * v * v;
        const u = Math.max(random(), 1e-12);
        if (u < 1 - 0.0331 * x * x * x * x)
            return d * v;
        if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v)))
            return d * v;
    }
}
/** One Beta draw from a posterior. */
export function betaSample(stat, random) {
    const a = gammaSample(Math.max(PRIOR, stat.alpha), random);
    const b = gammaSample(Math.max(PRIOR, stat.beta), random);
    const total = a + b;
    return total > 0 ? a / total : 0.5;
}
export const DEFAULT_DECIDE_OPTIONS = {
    exploreFloor: 0.1,
    warmupObservations: 50,
    seed: 'learning',
};
/** Total observation count across all arms of one bucket. */
export function bucketObservations(state, bucket) {
    const arms = state.buckets[bucket];
    if (arms === undefined)
        return 0;
    return Object.values(arms).reduce((sum, stat) => sum + stat.n, 0);
}
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
export function decide(state, bucket, options = DEFAULT_DECIDE_OPTIONS) {
    const floor = Math.min(1, Math.max(0, options.exploreFloor));
    const total = bucketObservations(state, bucket);
    const indexFromHash = hash32(`${options.seed}|${bucket}|warmup`) % ARMS.length;
    if (total < options.warmupObservations) {
        const arm = ARMS[indexFromHash] ?? ARMS[0];
        return { arm, armKey: armKey(arm), propensity: 1, exploration: false, warmup: true };
    }
    const random = prng(hash32(`${options.seed}|${bucket}|sample`));
    // Return the exploration flag alongside the arm: the guardrail metric
    // "exploration share ≤ floor" needs the real branch, not an inference from
    // the propensity number (a posterior draw can also pick a rarely-used arm).
    const draw = () => {
        if (random() < floor) {
            const uniformIndex = Math.floor(random() * ARMS.length);
            return { arm: ARMS[uniformIndex] ?? ARMS[0], exploration: true };
        }
        let best = ARMS[0];
        let bestValue = -1;
        for (const arm of ARMS) {
            const stat = state.buckets[bucket]?.[armKey(arm)] ?? { alpha: PRIOR, beta: PRIOR, n: 0, ts: 0 };
            const value = betaSample(stat, random);
            if (value > bestValue) {
                bestValue = value;
                best = arm;
            }
        }
        return { arm: best, exploration: false };
    };
    const chosen = draw();
    const chosenKey = armKey(chosen.arm);
    // Reproducible propensity estimate: 64 independent draws of the same policy.
    const REPLAYS = 64;
    let wins = 0;
    for (let i = 0; i < REPLAYS; i++) {
        if (armKey(draw().arm) === chosenKey)
            wins++;
    }
    const uniformShare = floor / ARMS.length;
    const posteriorShare = (1 - floor) * (wins / REPLAYS);
    return {
        arm: chosen.arm,
        armKey: chosenKey,
        propensity: Math.min(1, Math.max(0, uniformShare + posteriorShare)),
        exploration: chosen.exploration,
        warmup: false,
    };
}
/**
 * Offline full-information warmup (OrcaRouter style, miniaturised): seed a
 * bucket's posteriors from precomputed golden-set scores. `score` is in [0,1].
 * No model call happens here — the caller supplies the scores.
 */
export function warmupFromScores(state, bucket, arm, scores) {
    const key = armKey(arm);
    const arms = state.buckets[bucket] ?? {};
    const current = arms[key] ?? { alpha: PRIOR, beta: PRIOR, n: 0, ts: 0 };
    let alpha = current.alpha;
    let beta = current.beta;
    for (const raw of scores) {
        const score = Math.min(1, Math.max(0, raw));
        alpha += score;
        beta += 1 - score;
    }
    arms[key] = { alpha, beta, n: current.n + scores.length, ts: Date.now() };
    state.buckets[bucket] = arms;
    state.updatedAt = Date.now();
    boundLearningState(state);
}
