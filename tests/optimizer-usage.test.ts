import { describe, expect, it } from 'vitest'
import { emptyUsage, normalizeLoadedUsage, normalizeRoute, toModelRoute, usageCount, type ResolvedRoute, type UsageLedger } from '../src/optimizer/usage.js'

/** A valid ledger with every count on a distinctive positive value. */
function cleanLedger(): UsageLedger {
  return {
    usageCalls: 3,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 20,
    reasoningTokens: 5,
    lastRunUsage: { calls: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 20, reasoningTokens: 5 },
    lastRunRoute: { provider: 'p', model: 'm' },
    selectRuns: 2,
    selectGains: 1,
    lastSelectCandidates: 3,
    lastSelectChosen: 2,
    lastSelectScore: 0.75,
    lastSelectGate: 0.5,
    feedbackSessions: 4,
    feedbackPositive: 3,
    feedbackNegative: 1,
    feedbackBiasApplied: 0.1,
  }
}

describe('usageCount', () => {
  it('keeps finite positive counts', () => {
    expect(usageCount(5)).toBe(5)
  })

  it('repairs missing, non-finite and negative values to 0 (reverse control: corruption cannot propagate)', () => {
    expect(usageCount(undefined)).toBe(0)
    expect(usageCount(NaN)).toBe(0)
    expect(usageCount(Infinity)).toBe(0)
    expect(usageCount(-3)).toBe(0)
    expect(usageCount(0)).toBe(0)
  })
})

describe('normalizeRoute', () => {
  it('keeps a valid route, carrying a non-empty reasoningEffort', () => {
    expect(normalizeRoute({ provider: 'p', model: 'm', reasoningEffort: 'high' })).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  })

  it('drops junk and half-formed routes instead of displaying them (reverse control)', () => {
    expect(normalizeRoute(null)).toBeNull()
    expect(normalizeRoute(undefined)).toBeNull()
    expect(normalizeRoute('route')).toBeNull()
    expect(normalizeRoute(42)).toBeNull()
    expect(normalizeRoute({})).toBeNull()
    expect(normalizeRoute({ provider: '', model: 'm' })).toBeNull()
    expect(normalizeRoute({ provider: 'p', model: '' })).toBeNull()
    expect(normalizeRoute({ provider: 1, model: 'm' })).toBeNull()
  })

  it('drops a non-string or empty reasoningEffort but keeps the route', () => {
    expect(normalizeRoute({ provider: 'p', model: 'm', reasoningEffort: 3 })).toEqual({ provider: 'p', model: 'm' })
    expect(normalizeRoute({ provider: 'p', model: 'm', reasoningEffort: '' })).toEqual({ provider: 'p', model: 'm' })
  })
})

describe('normalizeLoadedUsage', () => {
  it('leaves a clean ledger untouched', () => {
    const stats = cleanLedger()
    normalizeLoadedUsage(stats)
    expect(stats.inputTokens).toBe(100)
    expect(stats.lastRunRoute).toEqual({ provider: 'p', model: 'm' })
    expect(stats.lastSelectScore).toBe(0.75)
    expect(stats.feedbackBiasApplied).toBeCloseTo(0.1)
  })

  it('repairs corrupt counts to 0 (a string would silently concatenate)', () => {
    const stats = cleanLedger()
    stats.inputTokens = 'corrupt' as unknown as number
    stats.usageCalls = -1
    stats.outputTokens = NaN
    normalizeLoadedUsage(stats)
    expect(stats.inputTokens).toBe(0)
    expect(stats.usageCalls).toBe(0)
    expect(stats.outputTokens).toBe(0)
  })

  it('repairs a legitimate zero score while flooring negative and non-finite ones', () => {
    const zero = cleanLedger()
    zero.lastSelectScore = 0
    normalizeLoadedUsage(zero)
    expect(zero.lastSelectScore).toBe(0)

    const corrupt = cleanLedger()
    corrupt.lastSelectScore = -0.5
    normalizeLoadedUsage(corrupt)
    expect(corrupt.lastSelectScore).toBe(0)
  })

  it('rebuilds lastRunUsage from a partial object and nulls non-objects', () => {
    const partial = cleanLedger()
    partial.lastRunUsage = { inputTokens: 7 } as UsageLedger['lastRunUsage']
    normalizeLoadedUsage(partial)
    expect(partial.lastRunUsage).toEqual({ calls: 0, inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })

    const junk = cleanLedger()
    junk.lastRunUsage = 'corrupt' as unknown as UsageLedger['lastRunUsage']
    normalizeLoadedUsage(junk)
    expect(junk.lastRunUsage).toBeNull()
  })

  it('routes a corrupt lastRunRoute through normalizeRoute (null out)', () => {
    const junk = cleanLedger()
    junk.lastRunRoute = 'corrupt' as unknown as UsageLedger['lastRunRoute']
    normalizeLoadedUsage(junk)
    expect(junk.lastRunRoute).toBeNull()
  })
})

describe('emptyUsage and toModelRoute', () => {
  it('emptyUsage zeroes every count', () => {
    expect(emptyUsage()).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })
  })

  it('toModelRoute omits reasoningEffort when absent and copies it as a plain string when present', () => {
    expect(toModelRoute({ provider: 'p', model: 'm' })).toEqual({ provider: 'p', model: 'm' })
    // `reasoningEffort` is a branded host type internally; any non-empty string
    // must survive the narrowing to the portable plain-string form.
    const internal = { provider: 'p', model: 'm', reasoningEffort: 'high' } as unknown as ResolvedRoute
    expect(toModelRoute(internal)).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  })
})
