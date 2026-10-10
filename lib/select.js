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
export const SELECT_MIN_SCORE = 1;
export const SELECT_MAX_SCORE = 5;
/**
 * How much better than the baseline (candidate 0) another candidate must score
 * before it is adopted. A tie or a marginal win is not worth the extra model
 * calls the alternative cost, and reporting "we picked candidate 3" for a
 * 0.01 difference would be noise dressed as a decision.
 */
export const DEFAULT_SELECT_MIN_GAIN = 0.05;
/**
 * Temperature added per additional candidate. Diversity is the whole point of
 * generating more than one candidate, and the harness gives us exactly one
 * knob that reliably changes the draw.
 */
export const SELECT_TEMPERATURE_SPREAD = 0.35;
/** Hard ceiling on candidate count (cost bound; also a config bound). */
export const SELECT_MAX_CANDIDATES = 5;
/**
 * Structural fallback score, used when no judge runs (`selectJudge: false` or
 * a judge failure): among candidates that passed the same gate, the longer one
 * carries more of the model's output — the cheapest honest tie-break. It is
 * deliberately NOT the model's token count: this layer must stay free, and
 * `scale` maps characters into the same 0–1 band the judge produces so the two
 * are comparable numbers rather than two different units.
 */
export function structuralScore(chars, scale = 2000) {
    if (!Number.isFinite(chars) || chars <= 0)
        return 0;
    return Math.min(1, chars / scale);
}
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
export function selectCandidatePure(candidates, scores, options = {}) {
    const minGain = options.minGain ?? DEFAULT_SELECT_MIN_GAIN;
    const eligible = (score) => score !== undefined && score.gate?.passed === true;
    const scored = scores.filter((score) => eligible(score) && score.score !== undefined);
    const eligibleCount = scored.length;
    const baseline = scores[0];
    const baselineEligible = eligible(baseline);
    const best = pickBest(scored);
    // `gain` is a claim about MEASURED quality, so it needs a score to compare:
    // either the baseline was measured and the winner beat it by `minGain`, or
    // the baseline is eligible but UNMEASURED (a judge failure is not evidence
    // that it was good). A baseline that failed the gate is not a baseline to
    // beat — the winner is merely the survivor, and the reason says so.
    const beatsBaseline = best !== undefined
        && best.index !== 0
        && best.score !== undefined
        && baselineEligible
        && (baseline?.score === undefined || best.score - baseline.score >= minGain);
    // The winner search, in order: a preferred scored candidate; else the
    // baseline when it is eligible; else the first gate-passing candidate — a
    // candidate the judge could not score is still a candidate, and the
    // alternative is returning a prompt the gate already rejected.
    const winner = (beatsBaseline ? best : undefined)
        ?? (baselineEligible ? baseline : undefined)
        ?? scored[0]
        ?? scores.find((score) => eligible(score));
    // The reason is stated, never inferred by the caller: `gain` means another
    // draw genuinely won, `only-eligible` means nothing was preferred (only
    // survivors were left), `baseline` means the baseline kept the result (it
    // was best, nobody beat it by `minGain`, or it won a tie).
    const reason = beatsBaseline
        ? 'gain'
        : baselineEligible ? 'baseline' : 'only-eligible';
    return {
        chosenIndex: winner?.index ?? 0,
        reason,
        scores: scores.map((score) => ({ ...score })),
        eligible: eligibleCount,
        ...(winner?.score !== undefined ? { score: winner.score } : {}),
    };
}
/**
 * Highest-scoring candidate among the scored ones. A tie keeps the EARLIER
 * index, so candidate 0 wins ties by construction and a selection run cannot
 * silently prefer a later draw for no reason.
 */
function pickBest(scored) {
    let best;
    for (const score of scored) {
        if (best === undefined || score.score > best.score)
            best = score;
    }
    return best;
}
/**
 * Score every candidate: run the deterministic gate first (cheap, offline, and
 * authoritative), then hand the survivors to the judge.
 *
 * A gate failure produces NO score rather than a low one — the same rule the
 * evaluation harness applies, for the same reason: an injection canary that
 * survived must not be tradeable against an otherwise pretty prompt.
 */
export async function scoreCandidates(candidates, gate, options = {}) {
    // Gates are synchronous and cheap, so they run first and in order; only the
    // survivors are judged, and the judge calls run CONCURRENTLY (candidate
    // quality is independent per candidate, and serializing them would make the
    // wall-clock cost of N candidates N times one call).
    const gated = candidates.map((candidate, index) => {
        const verdict = gate(candidate);
        return { index, source: candidate.source, chars: candidate.prompt.length, gate: verdict, candidate };
    });
    const judged = await Promise.all(gated.map(async (entry) => {
        const { candidate, ...base } = entry;
        if (!base.gate?.passed)
            return { ...base, error: 'gate-failed' };
        if (options.judge === undefined)
            return { ...base, score: structuralScore(candidate.prompt.length) };
        let verdict;
        try {
            verdict = await options.judge(candidate);
        }
        catch {
            // A judge failure is not a candidate failure: the candidate stays
            // eligible with no score, and ranking falls back to the structural order
            // rather than discarding a valid prompt.
            return { ...base, error: 'judge-error' };
        }
        if (verdict === undefined || !verdict.complete || verdict.normalized === undefined) {
            return { ...base, ...(verdict !== undefined ? { judge: verdict } : {}), error: 'judge-incomplete' };
        }
        return { ...base, judge: verdict, score: verdict.normalized };
    }));
    return judged;
}
/**
 * Temperature for candidate `index`: the configured temperature for the
 * baseline draw, growing by {@link SELECT_TEMPERATURE_SPREAD} per candidate so
 * the draws actually differ, clamped to the harness's 0–2 range.
 */
export function candidateTemperature(base, index, max = 2) {
    const value = base + Math.max(0, index) * SELECT_TEMPERATURE_SPREAD;
    return Math.min(max, Math.round(value * 1000) / 1000);
}
/** One-line human/metric summary of a selection (`candidates`/`score`/`reason`). */
export function formatSelection(summary, lang = 'zh') {
    const picks = summary.scores.length;
    const score = summary.score === undefined ? 'n/a' : summary.score.toFixed(2);
    if (lang === 'zh') {
        return `选择: 候选 ${summary.chosenIndex + 1}/${picks}（${score}，${summary.reason === 'gain' ? '择优' : summary.reason === 'only-eligible' ? '唯一合规' : '保基线'}）｜ 结构门 ${summary.eligible}/${picks}`;
    }
    return `Selection: candidate ${summary.chosenIndex + 1}/${picks} (${score}, ${summary.reason}) ｜ gate ${summary.eligible}/${picks}`;
}
/** Machine-readable token for `/optimize --stats` (numbers only, no prose). */
export function selectionToken(summary) {
    const scores = summary.scores.map((score) => (score.score === undefined ? 'na' : score.score.toFixed(3))).join('/');
    return `SELECT:${summary.chosenIndex + 1}/${summary.scores.length}|SELECTREASON:${summary.reason.toUpperCase()}|SELECTGATE:${summary.eligible}|SELECTSCORES:${scores}`;
}
