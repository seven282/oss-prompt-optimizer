/** A zeroed usage accumulator. */
export function emptyUsage() {
    return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}
/**
 * Coerce one provider-reported count: missing, non-finite or negative values
 * become 0, so a partially-populated `TokenUsage` cannot poison the ledger
 * (an adapter may omit the optional cache/reasoning fields entirely).
 */
export function usageCount(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
/**
 * Repair a persisted route (1.13.0). A file written before this version simply
 * lacks the field; a corrupt one can carry anything. Anything without a
 * non-empty `provider`/`model` pair is dropped rather than displayed as the
 * model that produced the last run.
 */
export function normalizeRoute(value) {
    if (value === null || typeof value !== 'object')
        return null;
    const candidate = value;
    if (typeof candidate.provider !== 'string' || candidate.provider.length === 0)
        return null;
    if (typeof candidate.model !== 'string' || candidate.model.length === 0)
        return null;
    const route = { provider: candidate.provider, model: candidate.model };
    if (typeof candidate.reasoningEffort === 'string' && candidate.reasoningEffort.length > 0) {
        route.reasoningEffort = candidate.reasoningEffort;
    }
    return route;
}
/**
 * Repair the usage ledger of a state file loaded from disk (1.10.0). A file
 * written before this version simply lacks the fields (`Object.assign` leaves
 * the defaults), but a corrupt one can carry a string where a count belongs —
 * and `stats.inputTokens += …` on a string silently produces concatenation
 * instead of arithmetic, which would then be reported as fact. Loading is
 * documented as best-effort, so repair rather than throw.
 */
export function normalizeLoadedUsage(stats) {
    stats.usageCalls = usageCount(stats.usageCalls);
    stats.inputTokens = usageCount(stats.inputTokens);
    stats.outputTokens = usageCount(stats.outputTokens);
    stats.cacheReadTokens = usageCount(stats.cacheReadTokens);
    stats.cacheWriteTokens = usageCount(stats.cacheWriteTokens);
    stats.reasoningTokens = usageCount(stats.reasoningTokens);
    stats.selectRuns = usageCount(stats.selectRuns);
    stats.selectGains = usageCount(stats.selectGains);
    stats.lastSelectCandidates = usageCount(stats.lastSelectCandidates);
    stats.lastSelectChosen = usageCount(stats.lastSelectChosen);
    stats.lastSelectGate = usageCount(stats.lastSelectGate);
    // Scores are fractions: `usageCount`'s `> 0` floor happens to be right for
    // them too (a negative or non-finite score is corruption), but a legitimate
    // 0 must survive, so the score is repaired rather than required positive.
    stats.lastSelectScore = typeof stats.lastSelectScore === 'number' && Number.isFinite(stats.lastSelectScore) && stats.lastSelectScore >= 0
        ? stats.lastSelectScore
        : 0;
    stats.feedbackSessions = usageCount(stats.feedbackSessions);
    stats.feedbackPositive = usageCount(stats.feedbackPositive);
    stats.feedbackNegative = usageCount(stats.feedbackNegative);
    stats.feedbackBiasApplied = typeof stats.feedbackBiasApplied === 'number' && Number.isFinite(stats.feedbackBiasApplied)
        ? stats.feedbackBiasApplied
        : 0;
    const last = stats.lastRunUsage;
    stats.lastRunUsage = last !== null && typeof last === 'object'
        ? {
            calls: usageCount(last.calls),
            inputTokens: usageCount(last.inputTokens),
            outputTokens: usageCount(last.outputTokens),
            cacheReadTokens: usageCount(last.cacheReadTokens),
            cacheWriteTokens: usageCount(last.cacheWriteTokens),
            reasoningTokens: usageCount(last.reasoningTokens),
        }
        : null;
    stats.lastRunRoute = normalizeRoute(stats.lastRunRoute);
}
/** Narrow an internal route to its portable form (drops nothing we can name). */
export function toModelRoute(route) {
    return route.reasoningEffort === undefined
        ? { provider: route.provider, model: route.model }
        : { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort };
}
