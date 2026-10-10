/**
 * Usage ledger and model-route layer of the optimizer (moved verbatim from
 * `optimizer.ts`, which re-exports the public names).
 *
 * Invariant: every count that leaves this module is a finite non-negative
 * number or an honest zero — a corrupt or absent value is repaired, never
 * propagated (a string in a token field would silently concatenate instead of
 * adding, and then be reported as fact).
 *
 * @module optimizer/usage
 */
// Type-only: erased at compile time, so a harness rename cannot break loading.
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

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
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

/** A zeroed usage accumulator. */
export function emptyUsage(): RunUsage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
}

/**
 * Coerce one provider-reported count: missing, non-finite or negative values
 * become 0, so a partially-populated `TokenUsage` cannot poison the ledger
 * (an adapter may omit the optional cache/reasoning fields entirely).
 */
export function usageCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Run-statistics snapshot (观测; see `getStats`). */
export interface OptimizeStats {
  runs: number
  success: number
  failed: number
  cached: number
  /** Local zero-token template renders (1.5.6, 观测). */
  local: number
  /** Local renders refined by a cheap LLM call (1.6.1 `hybrid`, 观测). */
  refined: number
  totalDurationMs: number
  maxDurationMs: number
  lastOutputTokens: number
  lastCallMs: number
  avgCallMs: number
  maxCallMs: number
  totalCallMs: number
  callCount: number
  lastRunCalls: number
  lastInputTokens: number
  /**
   * Provider-reported usage, cumulative over the plugin's lifetime (1.10.0).
   * Before this the plugin only ever showed HEURISTIC estimates; `usageCalls`
   * is what tells the two apart — when it is 0 the provider reported nothing
   * and the `*Tokens` fields above are guesses, when it is > 0 these fields
   * are the real numbers and the guesses are the fallback.
   */
  usageCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /**
   * Provider-reported usage of the most recent optimization run (`null` when
   * no usage was reported for it). Rides along with `lastRunCalls`, so a run
   * that made 2 calls and reported nothing is distinguishable from one that
   * reported 2 calls' worth of tokens.
   */
  lastRunUsage: RunUsage | null
  /**
   * The route the most recent run actually called (1.13.0, benchmark checklist
   * item 6). `null` when that run made no model call — a local zero-token
   * render or a cache hit — because keeping the previous model there would
   * attribute it to a run that never used it.
   */
  lastRunRoute: ModelRoute | null
  /**
   * Best-of-N selection counters (1.12.0 P1-A). `selectRuns` counts runs that
   * generated more than one candidate; `selectGains` counts the subset where a
   * later candidate actually replaced the baseline draw — the ratio is the
   * only honest answer to "is the extra spend buying anything".
   */
  selectRuns: number
  selectGains: number
  lastSelectCandidates: number
  lastSelectChosen: number
  lastSelectScore: number
  lastSelectGate: number
  /**
   * Host feedback signal (1.12.0 P1-B), counts only. `feedbackSessions` is how
   * many sessions were read; the positive/negative tallies are judgments the
   * human filed on assistant messages, and `feedbackBiasApplied` is the
   * temperature delta they produced on the last run.
   */
  feedbackSessions: number
  feedbackPositive: number
  feedbackNegative: number
  feedbackBiasApplied: number
}

/** The usage-ledger fields of a stats snapshot (the part a state file can carry). */
export type UsageLedger = Pick<
  OptimizeStats,
  'usageCalls' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens' | 'lastRunUsage'
    | 'lastRunRoute'
    | 'selectRuns' | 'selectGains' | 'lastSelectCandidates' | 'lastSelectChosen' | 'lastSelectScore' | 'lastSelectGate'
    | 'feedbackSessions' | 'feedbackPositive' | 'feedbackNegative' | 'feedbackBiasApplied'
>

/**
 * Repair a persisted route (1.13.0). A file written before this version simply
 * lacks the field; a corrupt one can carry anything. Anything without a
 * non-empty `provider`/`model` pair is dropped rather than displayed as the
 * model that produced the last run.
 */
export function normalizeRoute(value: unknown): ModelRoute | null {
  if (value === null || typeof value !== 'object') return null
  const candidate = value as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
  if (typeof candidate.provider !== 'string' || candidate.provider.length === 0) return null
  if (typeof candidate.model !== 'string' || candidate.model.length === 0) return null
  const route: ModelRoute = { provider: candidate.provider, model: candidate.model }
  if (typeof candidate.reasoningEffort === 'string' && candidate.reasoningEffort.length > 0) {
    route.reasoningEffort = candidate.reasoningEffort
  }
  return route
}

/**
 * Repair the usage ledger of a state file loaded from disk (1.10.0). A file
 * written before this version simply lacks the fields (`Object.assign` leaves
 * the defaults), but a corrupt one can carry a string where a count belongs —
 * and `stats.inputTokens += …` on a string silently produces concatenation
 * instead of arithmetic, which would then be reported as fact. Loading is
 * documented as best-effort, so repair rather than throw.
 */
export function normalizeLoadedUsage(stats: UsageLedger): void {
  stats.usageCalls = usageCount(stats.usageCalls)
  stats.inputTokens = usageCount(stats.inputTokens)
  stats.outputTokens = usageCount(stats.outputTokens)
  stats.cacheReadTokens = usageCount(stats.cacheReadTokens)
  stats.cacheWriteTokens = usageCount(stats.cacheWriteTokens)
  stats.reasoningTokens = usageCount(stats.reasoningTokens)
  stats.selectRuns = usageCount(stats.selectRuns)
  stats.selectGains = usageCount(stats.selectGains)
  stats.lastSelectCandidates = usageCount(stats.lastSelectCandidates)
  stats.lastSelectChosen = usageCount(stats.lastSelectChosen)
  stats.lastSelectGate = usageCount(stats.lastSelectGate)
  // Scores are fractions: `usageCount`'s `> 0` floor happens to be right for
  // them too (a negative or non-finite score is corruption), but a legitimate
  // 0 must survive, so the score is repaired rather than required positive.
  stats.lastSelectScore = typeof stats.lastSelectScore === 'number' && Number.isFinite(stats.lastSelectScore) && stats.lastSelectScore >= 0
    ? stats.lastSelectScore
    : 0
  stats.feedbackSessions = usageCount(stats.feedbackSessions)
  stats.feedbackPositive = usageCount(stats.feedbackPositive)
  stats.feedbackNegative = usageCount(stats.feedbackNegative)
  stats.feedbackBiasApplied = typeof stats.feedbackBiasApplied === 'number' && Number.isFinite(stats.feedbackBiasApplied)
    ? stats.feedbackBiasApplied
    : 0
  const last: Partial<RunUsage> | null | undefined = stats.lastRunUsage
  stats.lastRunUsage = last !== null && typeof last === 'object'
    ? {
        calls: usageCount(last.calls),
        inputTokens: usageCount(last.inputTokens),
        outputTokens: usageCount(last.outputTokens),
        cacheReadTokens: usageCount(last.cacheReadTokens),
        cacheWriteTokens: usageCount(last.cacheWriteTokens),
        reasoningTokens: usageCount(last.reasoningTokens),
      }
    : null
  stats.lastRunRoute = normalizeRoute(stats.lastRunRoute)
}

/** Resolved model route for one optimization call. */
export interface ResolvedRoute {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
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
  provider: string
  model: string
  reasoningEffort?: string
}

/** Narrow an internal route to its portable form (drops nothing we can name). */
export function toModelRoute(route: ResolvedRoute): ModelRoute {
  return route.reasoningEffort === undefined
    ? { provider: route.provider, model: route.model }
    : { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort }
}
